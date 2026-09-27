/**
 * OAuth authorization for Streamable HTTP MCP servers: one MCP SDK
 * `OAuthClientProvider` per configured server, persisted in a harness
 * credential record, plus the `dsh-authorization` flow that walks a human
 * through consent with a loopback redirect listener and a paste fallback.
 *
 * The SDK owns the protocol — protected-resource and authorization-server
 * discovery (RFC 9728 / RFC 8414), dynamic client registration (RFC 7591),
 * PKCE, token exchange and refresh, and the secure-token-endpoint refusal.
 * This module owns the harness translation: where credentials live (one
 * `mcp-client/<record id>` grant record per server), how a human consents
 * (the authorization seam's notices and prompts), and when the interactive
 * dance may run at all — only inside a flow attempt. A headless connect that
 * meets 401 fails with the action it needs ({@link McpAuthRequiredError}),
 * never with a staged redirect nobody can complete.
 *
 * @module
 */

import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { auth as sdkAuth } from '@modelcontextprotocol/client'
import type {
  OAuthClientInformationContext, OAuthClientMetadata, OAuthClientProvider, OAuthDiscoveryState,
  StoredOAuthClientInformation, StoredOAuthTokens,
} from '@modelcontextprotocol/client'
import type { Context } from '@deepseek-ai/cordis'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey, CredentialProvider, CredentialRecord, GrantRecord } from '@deepseek-ai/dsh-credentials'

/**
 * The credential-record scope every MCP OAuth grant is stored under. It is
 * this plugin's registered name, which tells a later reader — a settings
 * surface, or this plugin after a restart — that this plugin owns the format
 * inside the record.
 */
export const MCP_OAUTH_RECORD_SCOPE = 'mcp-client'

/** How long the loopback listener waits for the authorization redirect. */
export const CALLBACK_WAIT_MS = 300_000

/** The path the authorization server redirects back to on the loopback listener. */
const CALLBACK_PATH = '/callback'

/**
 * Configuration for OAuth authorization against a Streamable HTTP server's
 * authorization server. All fields except `kind` are optional.
 */
export interface OAuthAuthConfig {
  /** Selects the OAuth authorization-code-with-PKCE flow. */
  kind: 'oauth'
  /** Scopes to request; omission follows the server's advertised defaults. */
  scopes?: string[]
  /** Client name shown during dynamic client registration. */
  clientName?: string
  /**
   * Pre-registered client id, for authorization servers without dynamic client
   * registration. Omission registers a client dynamically and stores it in the
   * grant record.
   */
  clientId?: string
  /**
   * Pre-registered client secret. A secret is configuration, so the documented
   * `!!js` environment reference keeps it out of committed files.
   */
  clientSecret?: string
  /**
   * Fixed loopback callback port, for authorization servers that only accept
   * pre-registered redirect URIs; omission uses an ephemeral port.
   */
  callbackPort?: number
}

/** Facts one OAuth-configured server contributes to its provider and flow. */
export interface McpOAuthOptions {
  /** The configured `serverName`; names the record and the flow's label. */
  serverName: string
  /** The configured Streamable HTTP endpoint; the OAuth protected resource. */
  serverUrl: string
  /** The resolved `auth` configuration. */
  auth: OAuthAuthConfig
  /** The credential record this server's grant is stored under. */
  key: CredentialKey
  /**
   * Which half of the authorization this instance serves. A `flow` provider
   * runs the interactive sign-in and owns dynamic client registration; a
   * `connection` provider serves the transport's per-request bearer reads and
   * silent refreshes, and refuses — rather than stages — when only an
   * interactive sign-in could proceed. The two roles share the record and
   * nothing else, which is what keeps a reconnect attempt racing a sign-in
   * from overwriting the sign-in's staged verifier.
   */
  role: 'flow' | 'connection'
}

/**
 * The grant payload this plugin stores, verbatim SDK OAuth values plus this
 * plugin's own bookkeeping. Opaque to the credential seam, like every grant.
 */
export interface McpOAuthGrant {
  /** The registered (or pre-registered) OAuth client, bound to its issuer. */
  clientInformation?: StoredOAuthClientInformation
  /** The current token set, bound to its issuer. */
  tokens?: StoredOAuthTokens
}

/**
 * The error a connection attempt reports when the server demands OAuth and no
 * usable grant is stored: interactive authorization may only run inside a flow
 * attempt, so the transport-driven path refuses instead of staging a redirect.
 */
export class McpAuthRequiredError extends Error {
  constructor(serverName: string, key: CredentialKey) {
    super(
      `MCP server "${serverName}" requires OAuth authorization and no valid grant is stored —`
      + ` authorize credential "${key}" from a settings surface and the connection retries automatically`,
    )
    this.name = 'McpAuthRequiredError'
  }
}

/**
 * The record id one configured server's grant is stored under: the
 * `serverName` lowercased with underscores as hyphens, so every
 * `[A-Za-z0-9_-]` name maps into the record grammar's lowercase-hyphenated
 * ids. Callers validate the result with the credential seam's own segment
 * predicate and fail the plugin instance at load when it cannot address a
 * record.
 * @param serverName - the configured server name.
 * @returns the record id under scope {@link MCP_OAUTH_RECORD_SCOPE}.
 */
export function mcpOAuthRecordId(serverName: string): string {
  return serverName.toLowerCase().replaceAll('_', '-')
}

/**
 * The credential record address for one configured server.
 * @param serverName - the configured server name.
 * @returns the branded key under scope {@link MCP_OAUTH_RECORD_SCOPE}.
 */
export function mcpOAuthRecordKey(serverName: string): CredentialKey {
  return credentialKey(MCP_OAUTH_RECORD_SCOPE, mcpOAuthRecordId(serverName))
}

/** The per-attempt state this provider keeps in memory only. */
interface OAuthAttemptState {
  /** The loopback URL registered for this attempt; `redirectUrl` reports it. */
  redirectUrl: URL
  /** The binding `state` value this attempt's callback must echo. */
  state: string
  /** The PKCE verifier staged by leg one; leg two consumes it. */
  codeVerifier: string | undefined
  /** Discovery facts staged by leg one; leg two re-checks the issuer with them. */
  discovery: OAuthDiscoveryState | undefined
  /** The authorization URL staged by leg one, before the human is sent there. */
  authorizationUrl: URL | undefined
}

/**
 * The redirect a connection-role provider reports so the SDK keeps its
 * refresh path reachable. It is never sent anywhere: this role refuses before
 * registering a client or staging a code exchange, so the URL exists only to
 * keep `redirectUrl` truthy, which is how the SDK decides a flow is
 * interactive and reaches its stored-token refresh branch.
 */
const CONNECTION_PLACEHOLDER_REDIRECT = new URL('http://127.0.0.1/callback')

/**
 * The MCP SDK `OAuthClientProvider` for one configured server, over the
 * harness credential plane.
 *
 * Every read and write goes through `ctx.credentials` per operation, so a
 * grant another attempt commits reaches the next request without a restart.
 * The two roles split the interactive half: a `flow` provider's interactive
 * members throw {@link McpAuthRequiredError} outside a sign-in attempt, while
 * a `connection` provider never registers or stages — it serves bearer reads
 * and refreshes from the record, and refuses when the record holds nothing a
 * non-interactive run could use.
 */
export class McpOAuthProvider implements OAuthClientProvider {
  /** The facts this provider was built from; also read by the flow registration. */
  public readonly options: McpOAuthOptions
  private readonly ctx: Context
  private attempt: OAuthAttemptState | undefined

  constructor(ctx: Context, options: McpOAuthOptions) {
    this.ctx = ctx
    this.options = options
  }

  /**
   * The credential service, or the failure that names what is missing. Reads
   * and writes both refuse without it: a grant that silently evaporated would
   * report a successful authorization and then fail every request.
   */
  private store(): CredentialProvider {
    const credentials = this.ctx.get('credentials')
    if (credentials === undefined) {
      throw new Error(
        `mcp-client(${this.options.serverName}): auth oauth is configured but this composition mounts no`
        + ' credentials service — mount one (for example dsh-credentials-local) to authorize and store MCP server grants',
      )
    }
    return credentials
  }

  /**
   * The loopback redirect for the active attempt (a placeholder on a
   * connection-role provider, where it is inert bookkeeping). A flow provider
   * throws outside a sign-in attempt, which the SDK's client-metadata
   * resolution reads before any discovery or registration — so a
   * transport-driven 401 aborts with {@link McpAuthRequiredError} before it
   * touches the authorization server.
   */
  get redirectUrl(): URL {
    if (this.options.role === 'connection') return CONNECTION_PLACEHOLDER_REDIRECT
    if (this.attempt === undefined) throw new McpAuthRequiredError(this.options.serverName, this.options.key)
    return this.attempt.redirectUrl
  }

  get clientMetadata(): OAuthClientMetadata {
    const redirectUrl = this.redirectUrl
    return {
      client_name: this.options.auth.clientName ?? `dsh-mcp-client (${this.options.serverName})`,
      redirect_uris: [redirectUrl.toString()],
    }
  }

  /** One fresh binding value per attempt; the callback and the paste fallback both echo it. */
  state(): string {
    if (this.attempt === undefined) throw new McpAuthRequiredError(this.options.serverName, this.options.key)
    return this.attempt.state
  }

  /**
   * The configured pre-registered client when `clientId` is set, otherwise the
   * stored registration. The configuration override always wins so a rotated
   * pre-registered client replaces a stale stored one without a re-authorize.
   *
   * A connection-role provider with nothing stored refuses here: registration
   * belongs to the sign-in flow, and a reconnect attempt must not register a
   * client against a redirect no surface can complete.
   */
  async clientInformation(_ctx?: OAuthClientInformationContext): Promise<StoredOAuthClientInformation | undefined> {
    const { clientId, clientSecret } = this.options.auth
    if (clientId !== undefined) {
      return { client_id: clientId, ...(clientSecret !== undefined ? { client_secret: clientSecret } : {}) }
    }
    const stored = (await this.readGrant()).clientInformation
    if (stored === undefined && this.options.role === 'connection') {
      throw new McpAuthRequiredError(this.options.serverName, this.options.key)
    }
    return stored
  }

  /**
   * Persist a dynamic registration. Only a sign-in flow reaches this: the
   * connection role refuses in {@link clientInformation} before the SDK ever
   * registers, so a stored registration always names a redirect the flow can
   * complete.
   */
  async saveClientInformation(
    clientInformation: StoredOAuthClientInformation,
    _ctx?: OAuthClientInformationContext,
  ): Promise<void> {
    await this.writeGrant(grant => ({ ...grant, clientInformation }))
  }

  /**
   * The stored token set. Called with no context for the per-request bearer
   * read and with the resolved issuer inside the SDK's authorization runs;
   * this provider stores one set per server, and the SDK discards it upstream
   * when the stored issuer no longer matches.
   */
  async tokens(_ctx?: OAuthClientInformationContext): Promise<StoredOAuthTokens | undefined> {
    return (await this.readGrant()).tokens
  }

  async saveTokens(tokens: StoredOAuthTokens, _ctx?: OAuthClientInformationContext): Promise<void> {
    await this.writeGrant(grant => ({ ...grant, tokens }))
  }

  /** Remember the authorization URL leg one built, for the flow to hand to the human. */
  redirectToAuthorization(authorizationUrl: URL): void {
    if (this.attempt === undefined) throw new McpAuthRequiredError(this.options.serverName, this.options.key)
    this.attempt.authorizationUrl = authorizationUrl
  }

  saveCodeVerifier(codeVerifier: string): void {
    if (this.attempt === undefined) return
    this.attempt.codeVerifier = codeVerifier
  }

  /** The staged PKCE verifier; leg two cannot run without leg one's staging. */
  codeVerifier(): string {
    if (this.attempt?.codeVerifier === undefined) {
      throw new Error(`mcp-client(${this.options.serverName}): no OAuth code verifier is staged for this attempt`)
    }
    return this.attempt.codeVerifier
  }

  /**
   * Discovery facts, attempt-scoped in memory. Outside an attempt — a
   * transport-driven refresh — there is no callback leg to bind, so a save is
   * quietly dropped and a read reports nothing cached.
   */
  discoveryState(): OAuthDiscoveryState | undefined {
    return this.attempt?.discovery
  }

  /**
   * Stage discovery facts for the attempt's callback leg.
   * @param discovery - the discovery state leg one produced.
   */
  saveDiscoveryState(discovery: OAuthDiscoveryState): void {
    if (this.attempt === undefined) return
    this.attempt.discovery = discovery
  }

  /**
   * Drop stored credentials the authorization server rejected, so the SDK's
   * retry re-registers or re-authorizes instead of looping on the same
   * refusal. Verifier and discovery state are attempt memory, not records.
   */
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'verifier' || scope === 'discovery') {
      if (this.attempt !== undefined) {
        if (scope === 'verifier') this.attempt.codeVerifier = undefined
        else this.attempt.discovery = undefined
      }
      return
    }
    await this.writeGrant((grant) => {
      const next = { ...grant }
      if (scope === 'all' || scope === 'client') delete next.clientInformation
      if (scope === 'all' || scope === 'tokens') delete next.tokens
      return next
    })
  }

  /**
   * Arm the interactive members for one flow attempt.
   * @param redirectUrl - the loopback URL registered for this attempt.
   * @param state - the binding value this attempt's callback must echo.
   */
  beginAttempt(redirectUrl: URL, state: string): void {
    this.attempt = { redirectUrl, state, codeVerifier: undefined, discovery: undefined, authorizationUrl: undefined }
  }

  /** Disarm the interactive members; staged attempt memory is discarded. */
  endAttempt(): void {
    this.attempt = undefined
  }

  /**
   * Consume the authorization URL leg one staged, if it staged one.
   * @returns the staged URL, or undefined when leg one staged none.
   */
  takeAuthorizationUrl(): URL | undefined {
    return this.attempt?.authorizationUrl
  }

  /**
   * The grant as currently stored, for the flow's final seam-admitted commit.
   * @returns the stored grant, with absent members simply absent.
   */
  async currentGrant(): Promise<McpOAuthGrant> {
    return await this.readGrant()
  }

  private async readGrant(): Promise<McpOAuthGrant> {
    return parseGrant(this.options.key, await this.store().readRecord(this.options.key))
  }

  private async writeGrant(mutate: (grant: McpOAuthGrant) => McpOAuthGrant): Promise<void> {
    const key = this.options.key
    await this.store().modifyRecord(
      key, current => Promise.resolve<GrantRecord>({ kind: 'grant', payload: mutate(parseGrant(key, current)) }))
  }
}

/** Whether a value is a JSON object the grant's members could live in. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The remedy every malformed-record failure names. */
function malformedGrant(key: CredentialKey, member: string): Error {
  return new Error(
    `mcp-client: credential record "${key}" holds a malformed ${member}; remove the record and authorize again`,
  )
}

/**
 * Rebuild this plugin's grant from a stored record. The record is a durable
 * boundary, so the two members are structurally validated rather than
 * trusted: a corrupt record fails loud with the removal remedy instead of
 * sending garbage to the authorization server.
 * @param key - the record being read, for the failure message.
 * @param record - the stored record, or undefined when nothing is stored.
 * @returns the grant, with absent members simply absent.
 */
function parseGrant(key: CredentialKey, record: CredentialRecord | undefined): McpOAuthGrant {
  if (record === undefined) return {}
  if (record.kind !== 'grant') throw malformedGrant(key, 'record')
  const payload = record.payload
  if (!isPlainObject(payload)) throw malformedGrant(key, 'grant payload')
  const grant: McpOAuthGrant = {}
  const clientInformation = payload.clientInformation
  if (clientInformation !== undefined) {
    if (!isPlainObject(clientInformation) || typeof clientInformation.client_id !== 'string') {
      throw malformedGrant(key, 'client registration')
    }
    grant.clientInformation = clientInformation as StoredOAuthClientInformation
  }
  const tokens = payload.tokens
  if (tokens !== undefined) {
    if (!isPlainObject(tokens)
      || typeof tokens.access_token !== 'string'
      || typeof tokens.token_type !== 'string') throw malformedGrant(key, 'token set')
    const parsed: StoredOAuthTokens = { access_token: tokens.access_token, token_type: tokens.token_type }
    for (const member of ['id_token', 'scope', 'refresh_token', 'issuer'] as const) {
      const value = tokens[member]
      if (typeof value === 'string') parsed[member] = value
    }
    if (typeof tokens.expires_in === 'number') parsed.expires_in = tokens.expires_in
    grant.tokens = parsed
  }
  return grant
}

/** One authorization response captured from the redirect or the paste fallback. */
interface McpCallbackCapture {
  code: string
  iss?: string
}

/** How the loopback listener's wait can end. */
export type McpCallbackOutcome =
  | { status: 'code' } & McpCallbackCapture
  | { status: 'denied'; error: string }
  | { status: 'timeout' }

/** A running loopback listener for one attempt. */
export interface McpCallbackListener {
  /** The redirect URL to register for this attempt. */
  redirectUrl: URL
  /** Settles when the authorization response arrives, is refused, or times out. */
  outcome: Promise<McpCallbackOutcome>
  /** Stop listening; an unresolved wait settles as a timeout. */
  close(): Promise<void>
}

/** Constant-time equality for the attempt's binding value. */
function statesMatch(returned: string, expected: string): boolean {
  const left = Buffer.from(returned)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** One fresh binding value; 32 random bytes as hex. */
function randomState(): string {
  return randomBytes(32).toString('hex')
}

/**
 * Listen on the loopback interface for the authorization redirect. The MCP
 * authorization rules let a native client use a loopback IP redirect with any
 * port, so the listener binds an ephemeral port unless the configuration pins
 * one, and the resulting URL is exactly what the attempt registers.
 *
 * @param port - the configured callback port, or 0 for an ephemeral one.
 * @param state - the binding value this attempt's response must echo.
 * @param signal - withdraws the listener with the attempt.
 * @returns the listener carrying its redirect URL and pending outcome.
 */
export async function listenForCallback(port: number, state: string, signal: AbortSignal): Promise<McpCallbackListener> {
  const resolvers = Promise.withResolvers<McpCallbackOutcome>()
  let settled = false
  const finish = (outcome: McpCallbackOutcome): void => {
    if (!settled) {
      settled = true
      resolvers.resolve(outcome)
    }
  }
  const server = createServer((request, response) => {
    // Node's HTTP server always sets a request target; the fallback only keeps the parse total.
    /* v8 ignore next -- a live Node request always carries its target */
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== CALLBACK_PATH) {
      response.writeHead(404).end()
      return
    }
    const error = url.searchParams.get('error')
    if (error !== null) {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('The authorization server refused this sign-in. You can return to the app.')
      finish({ status: 'denied', error })
      return
    }
    const code = url.searchParams.get('code')
    const returnedState = url.searchParams.get('state')
    if (code === null || code === '' || returnedState === null || !statesMatch(returnedState, state)) {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('This is not the authorization response this sign-in expected.')
      finish({ status: 'denied', error: 'the authorization response did not match this sign-in attempt' })
      return
    }
    const iss = url.searchParams.get('iss') ?? undefined
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><meta charset="utf-8"><title>Authorized</title><p>Authorization received. You can return to the app.</p>')
    finish({ status: 'code', code, ...(iss !== undefined ? { iss } : {}) })
  })
  // An abandoned listener must never hold the host open on its own.
  server.unref()
  const listening = Promise.withResolvers<void>()
  server.once('error', (error) => { listening.reject(error) })
  server.listen(port, '127.0.0.1', () => { listening.resolve() })
  await listening.promise
  const address = server.address()
  /* v8 ignore next -- defensive: a bound TCP listener reports a TCP address */
  if (address === null || typeof address === 'string') throw new Error('MCP OAuth callback listener has no TCP address')
  const timer = setTimeout(
    /* v8 ignore next -- the 5-minute wall-clock bound is not unit-testable */
    () => { finish({ status: 'timeout' }) },
    CALLBACK_WAIT_MS,
  )
  timer.unref()
  const close = async (): Promise<void> => {
    clearTimeout(timer)
    finish({ status: 'timeout' })
    server.closeAllConnections()
    // A close error here means the listener was never listening or is
    // already closed — both are that-it-is-gone outcomes, which is all the
    // caller needs; an abort may legitimately race the initial bind.
    await new Promise<void>((resolve) => {
      server.close(() => { resolve() })
    })
  }
  signal.addEventListener('abort', () => { void close() }, { once: true })
  return { redirectUrl: new URL(`http://127.0.0.1:${address.port}${CALLBACK_PATH}`), outcome: resolvers.promise, close }
}

/**
 * Read the authorization code out of a pasted value: a full callback URL, a
 * bare `code=…&state=…` query, or the code alone. A pasted `state` that does
 * not echo this attempt refuses the paste rather than redeeming a foreign code.
 */
function parsePastedAuthorization(value: string, expectedState: string): McpCallbackCapture {
  const trimmed = value.trim()
  let query: URLSearchParams | undefined
  try {
    query = new URL(trimmed).searchParams
  } catch {
    if (trimmed.includes('=')) query = new URLSearchParams(trimmed)
  }
  if (query === undefined) return { code: trimmed }
  const code = query.get('code')
  if (code === null || code === '') throw new Error('the pasted authorization response contains no code')
  const returnedState = query.get('state')
  if (returnedState !== null && !statesMatch(returnedState, expectedState)) {
    throw new Error('the pasted authorization response belongs to a different sign-in attempt')
  }
  const iss = query.get('iss') ?? undefined
  return { code, ...(iss !== undefined ? { iss } : {}) }
}

/** Reject with the withdrawal reason the moment the attempt's signal fires. */
function raceAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('the authorization attempt was withdrawn'))
    }
    /* v8 ignore next -- the seam refuses an already-aborted attempt before the flow runs */
    if (signal.aborted) {
      abort()
      return
    }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/** Hooks the flow reports to the plugin instance that registered it. */
export interface McpOAuthFlowHooks {
  /**
   * Called once a grant is committed, so a connection waiting out its backoff
   * retries promptly instead of at the next scheduled attempt.
   */
  onAuthorized?: () => void
}

/**
 * Register the authorization flow for one OAuth-configured server on a context
 * that carries `ctx.authorization`. The flow offers one method — the browser
 * walk with the loopback redirect — and commits through the session so the
 * seam confirms the stored grant before reporting success.
 *
 * @param ctx - context carrying the authorization service.
 * @param provider - the server's provider; its record is what the flow writes.
 * @param hooks - the commit notification the connection supervisor consumes.
 */
export function registerMcpOAuthFlow(ctx: Context, provider: McpOAuthProvider, hooks: McpOAuthFlowHooks = {}): void {
  const { serverName, key } = provider.options
  ctx.authorization.registerFlow({
    key,
    label: `MCP server "${serverName}"`,
    methods: [{ id: 'oauth', label: 'Sign in with your browser' }],
    run: session => runOAuthAttempt(session, provider, hooks),
  })
}

/**
 * One interactive authorization attempt: discovery and registration, the
 * browser walk with the paste fallback, the code exchange, and the
 * seam-admitted commit. Every withdrawal path funnels through the attempt
 * signal; every staging path lives on the provider's attempt memory.
 */
async function runOAuthAttempt(session: AuthorizationSession, provider: McpOAuthProvider, hooks: McpOAuthFlowHooks): Promise<void> {
  const { serverName, serverUrl, auth } = provider.options
  const state = randomState()
  const listener = await listenForCallback(auth.callbackPort ?? 0, state, session.signal)
  provider.beginAttempt(listener.redirectUrl, state)
  try {
    const legOne = await raceAborted(sdkAuth(provider, { serverUrl }), session.signal)
    if (legOne === 'AUTHORIZED') {
      // A stored refresh token renewed itself; there was nothing to ask.
      await commitGrant(session, provider)
      hooks.onAuthorized?.()
      return
    }
    const authorizationUrl = provider.takeAuthorizationUrl()
    /* v8 ignore next 3 -- leg one returned REDIRECT, which always stages the
       authorization URL through redirectToAuthorization first. */
    if (authorizationUrl === undefined) throw new Error(`mcp-client(${serverName}): the authorization attempt staged no URL`)
    session.notify({
      message: `Open this page to authorize MCP server "${serverName}", then return here.`,
      url: authorizationUrl.toString(),
    })

    // Race the browser redirect against the paste fallback. The paste question
    // is withdrawn the moment either side wins; a declined paste cancels the
    // whole attempt, and a surface failure fails the flow.
    const withdrawPaste = new AbortController()
    const paste = session.prompt({
      kind: 'text',
      message: 'If the browser could not reach this machine, paste the authorization code or the full callback URL here.',
      signal: withdrawPaste.signal,
    }).then(value => ({ status: 'code' as const, ...parsePastedAuthorization(value, state) }))
    const raced = Promise.race([listener.outcome, paste])
    void paste.catch(() => { /* the losing paste question is withdrawn after the race */ })
    const outcome = await raced.finally(() => { withdrawPaste.abort() })

    if (outcome.status === 'timeout') {
      throw new Error(`mcp-client(${serverName}): no authorization response arrived within ${Math.round(CALLBACK_WAIT_MS / 1000)}s — start the sign-in again`)
    }
    if (outcome.status === 'denied') {
      throw new Error(`mcp-client(${serverName}): the authorization was refused: ${outcome.error}`)
    }
    const legTwo = await raceAborted(sdkAuth(provider, {
      serverUrl,
      authorizationCode: outcome.code,
      ...(outcome.iss !== undefined ? { iss: outcome.iss } : {}),
    }), session.signal)
    /* v8 ignore next 2 -- leg two either exchanges the code and returns
       AUTHORIZED or throws; REDIRECT needs an authorization code it cannot have. */
    if (legTwo !== 'AUTHORIZED') throw new Error(`mcp-client(${serverName}): the authorization code exchange did not complete`)
    await commitGrant(session, provider)
    hooks.onAuthorized?.()
  } finally {
    provider.endAttempt()
    await listener.close()
  }
}

/**
 * Commit the grant through the session: the seam admits the write against
 * withdrawal and confirms the record is stored before reporting the attempt
 * authorized. The provider has already persisted the same content through its
 * own record writes; this is the admitted copy of that fact.
 */
async function commitGrant(session: AuthorizationSession, provider: McpOAuthProvider): Promise<void> {
  const payload = await provider.currentGrant()
  await session.commit({ kind: 'grant', payload })
}
