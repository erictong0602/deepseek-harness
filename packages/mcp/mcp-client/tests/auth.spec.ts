/**
 * OAuth authorization tests: the config surface, the provider over credential
 * records, and the interactive flow against a real fixture authorization
 * server, including the supervised-connection path from unauthorized failure
 * through committed grant to registered tools.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type {
  CredentialInfo, CredentialKey, CredentialRecord, CredentialRecordEntry, CredentialRecordInfo, CredentialRef,
  ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import AuthorizationService, { AuthorizationDeclinedError } from '@deepseek-ai/dsh-authorization'
import type { AuthorizationInteraction } from '@deepseek-ai/dsh-authorization'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import McpResources from '@deepseek-ai/dsh-mcp-resources'
import { apply, Config as ConfigSchema } from '@deepseek-ai/dsh-mcp-client/src/index.ts'
import type { Config } from '@deepseek-ai/dsh-mcp-client'
import { resolveReconnectPolicy, startConnection } from '@deepseek-ai/dsh-mcp-client/src/connection.ts'
import {
  McpAuthRequiredError, McpOAuthProvider, listenForCallback, mcpOAuthRecordId, mcpOAuthRecordKey,
  registerMcpOAuthFlow,
} from '@deepseek-ai/dsh-mcp-client/src/auth.ts'
import type { OAuthAuthConfig } from '@deepseek-ai/dsh-mcp-client/src/auth.ts'
import { startOAuthMcpFixture } from './auth-fixture.ts'

// Near-duplicate of the record half of packages/credentials/authorization
// /tests/memory.ts; fold the copies into a shared test-support double.
class MemoryCredentials extends CredentialProvider {
  readonly records = new Map<CredentialKey, CredentialRecord>()

  override resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return Promise.resolve(undefined)
  }

  override describe(_ref: CredentialRef): Promise<CredentialInfo> {
    return Promise.resolve({ configured: false, writable: true })
  }

  override set(_ref: CredentialRef, _value: string): Promise<void> {
    return Promise.resolve()
  }

  override unset(_ref: CredentialRef): Promise<void> {
    return Promise.resolve()
  }

  override readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    return Promise.resolve(this.records.get(key))
  }

  override describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    const stored = this.records.get(key)
    return Promise.resolve(stored === undefined
      ? { configured: false, writable: true }
      : { configured: true, kind: stored.kind, writable: true })
  }

  override listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return Promise.resolve([...this.records].map(([key, record]) => ({ key, kind: record.kind })))
  }

  override async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const current = this.records.get(key)
    const next = await mutate(current)
    if (next === undefined) return current
    this.records.set(key, next)
    this.ctx.emit('credentials/record-updated', key)
    return next
  }

  override deleteRecord(key: CredentialKey): Promise<void> {
    if (this.records.delete(key)) this.ctx.emit('credentials/record-updated', key)
    return Promise.resolve()
  }
}

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })

/** Context with everything the plugin and its auth seam mount against. */
async function mountHost(credentials = true): Promise<Context> {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(McpResources)
  if (credentials) await ctx.plugin(MemoryCredentials)
  await ctx.plugin(AuthorizationService)
  return ctx
}

const KEY = credentialKey('mcp-client', 'srv')

function provider(
  ctx: Context,
  auth: OAuthAuthConfig = { kind: 'oauth' },
  role: 'flow' | 'connection' = 'flow',
): McpOAuthProvider {
  return new McpOAuthProvider(ctx, {
    serverName: 'srv',
    serverUrl: 'http://127.0.0.1:9/mcp',
    auth,
    key: KEY,
    role,
  })
}

/** The flow-role options for one fixture server. */
function flowOptions(fixture: { url: string }, auth: OAuthAuthConfig = { kind: 'oauth' }) {
  return { serverName: 'srv', serverUrl: fixture.url, auth, key: KEY, role: 'flow' } as const
}

/** An interaction that never answers the paste fallback. */
function browserOnlyInteraction(onUrl?: (url: string) => void): AuthorizationInteraction {
  return {
    notify: (notice) => {
      if (notice.url !== undefined) onUrl?.(notice.url)
    },
    prompt: question => new Promise<string>((_resolve, reject) => {
      question.signal?.addEventListener('abort', () => { reject(new Error('withdrawn')) }, { once: true })
    }),
  }
}

// ---- Config surface ----

describe('mcp-client OAuth configuration', () => {
  it('resolves a streamable-http config without auth to no auth', () => {
    const resolved = ConfigSchema({
      transport: 'streamable-http',
      serverName: 'srv',
      url: 'http://127.0.0.1:9/mcp',
    } as never)
    expect(resolved.transport).toBe('streamable-http')
    expect(resolved.transport === 'streamable-http' ? resolved.auth : 'n/a').toBeUndefined()
  })

  it('resolves oauth auth with its options', () => {
    const resolved = ConfigSchema({
      transport: 'streamable-http',
      serverName: 'srv',
      url: 'http://127.0.0.1:9/mcp',
      auth: { kind: 'oauth', scopes: ['read'], clientName: 'Harness', callbackPort: 8917 },
    } as never)
    expect(resolved.transport === 'streamable-http' ? resolved.auth : undefined)
      .toEqual({ kind: 'oauth', scopes: ['read'], clientName: 'Harness', callbackPort: 8917 })
  })

  it('rejects an auth kind other than oauth', () => {
    expect(() => ConfigSchema({
      transport: 'streamable-http',
      serverName: 'srv',
      url: 'http://127.0.0.1:9/mcp',
      auth: { kind: 'basic' },
    } as never)).toThrow()
  })

  it('maps record ids from server names', () => {
    expect(mcpOAuthRecordId('My_Server')).toBe('my-server')
    expect(mcpOAuthRecordKey('My_Server')).toBe(credentialKey('mcp-client', 'my-server'))
  })

  it('rejects a serverName whose lowercase form cannot address a record', async () => {
    const ctx = await mountHost()
    await expect(apply(ctx, {
      transport: 'streamable-http',
      serverName: '1st',
      url: 'http://127.0.0.1:9/mcp',
      auth: { kind: 'oauth' },
      headers: {},
      toolCallTimeoutMs: 500,
      failOnStartupError: false,
    })).rejects.toThrow(/whose lowercase form addresses a credential record/)
  })

  it('rejects a second server whose name folds onto the same record id', async () => {
    const ctx = await mountHost()
    const config = (serverName: string): Config => ({
      transport: 'streamable-http',
      serverName,
      url: 'http://127.0.0.1:9/mcp',
      auth: { kind: 'oauth' },
      headers: {},
      toolCallTimeoutMs: 500,
      failOnStartupError: false,
      reconnect: { enabled: false },
    })
    await apply(ctx, config('My_Server'))
    await expect(apply(ctx, config('my-server'))).rejects.toThrow(/already addresses OAuth credential record "my-server"/)
  })

  it('rejects empty scope entries', async () => {
    const ctx = await mountHost()
    await expect(apply(ctx, {
      transport: 'streamable-http',
      serverName: 'srv',
      url: 'http://127.0.0.1:9/mcp',
      auth: { kind: 'oauth', scopes: ['read', ' '] },
      headers: {},
      toolCallTimeoutMs: 500,
      failOnStartupError: false,
      reconnect: { enabled: false },
    })).rejects.toThrow(/auth\.scopes entries must be non-empty/)
  })
})

// ---- Provider over credential records ----

describe('McpOAuthProvider', () => {
  it('refuses interactive members outside an attempt and serves them inside one', async () => {
    const ctx = await mountHost()
    const p = provider(ctx)
    expect(() => p.redirectUrl).toThrow(McpAuthRequiredError)
    expect(() => p.clientMetadata).toThrow(McpAuthRequiredError)
    expect(() => p.state()).toThrow(McpAuthRequiredError)
    const redirectUrl = new URL('http://127.0.0.1:8917/callback')
    p.beginAttempt(redirectUrl, 'a-state')
    expect(p.redirectUrl).toBe(redirectUrl)
    expect(p.clientMetadata.redirect_uris).toEqual([redirectUrl.toString()])
    expect(p.clientMetadata.client_name).toBe('dsh-mcp-client (srv)')
    expect(p.state()).toBe('a-state')
    p.endAttempt()
    expect(() => p.redirectUrl).toThrow(McpAuthRequiredError)
  })

  it('round-trips client information and tokens through the credential record', async () => {
    const ctx = await mountHost()
    const p = provider(ctx)
    await expect(p.clientInformation()).resolves.toBeUndefined()
    await p.saveClientInformation({ client_id: 'as-issued', issuer: 'http://127.0.0.1:9' })
    await expect(p.clientInformation()).resolves.toEqual({ client_id: 'as-issued', issuer: 'http://127.0.0.1:9' })
    await expect(p.tokens()).resolves.toBeUndefined()
    await p.saveTokens({
      access_token: 'token-1', token_type: 'Bearer', refresh_token: 'refresh-1',
      expires_in: 3600, scope: 'read', issuer: 'http://127.0.0.1:9',
    })
    await expect(p.tokens()).resolves.toEqual({
      access_token: 'token-1', token_type: 'Bearer', refresh_token: 'refresh-1',
      expires_in: 3600, scope: 'read', issuer: 'http://127.0.0.1:9',
    })
    const store = ctx.get('credentials') as MemoryCredentials
    expect(store.records.get(KEY)).toEqual({
      kind: 'grant',
      payload: {
        clientInformation: { client_id: 'as-issued', issuer: 'http://127.0.0.1:9' },
        tokens: {
          access_token: 'token-1', token_type: 'Bearer', refresh_token: 'refresh-1',
          expires_in: 3600, scope: 'read', issuer: 'http://127.0.0.1:9',
        },
      },
    })
  })

  it('prefers the configured pre-registered client over the stored one', async () => {
    const ctx = await mountHost()
    const p = provider(ctx, { kind: 'oauth', clientId: 'static-id', clientSecret: 'static-secret' })
    await p.saveClientInformation({ client_id: 'as-issued' })
    await expect(p.clientInformation()).resolves.toEqual({ client_id: 'static-id', client_secret: 'static-secret' })
  })

  it('invalidates stored scopes selectively', async () => {
    const ctx = await mountHost()
    const p = provider(ctx)
    await p.saveClientInformation({ client_id: 'as-issued' })
    await p.saveTokens({ access_token: 'token-1', token_type: 'Bearer' })
    await p.invalidateCredentials('tokens')
    await expect(p.tokens()).resolves.toBeUndefined()
    await expect(p.clientInformation()).resolves.toEqual({ client_id: 'as-issued' })
    await p.saveTokens({ access_token: 'token-2', token_type: 'Bearer' })
    await p.invalidateCredentials('client')
    await expect(p.clientInformation()).resolves.toBeUndefined()
    await expect(p.tokens()).resolves.toEqual({ access_token: 'token-2', token_type: 'Bearer' })
    await p.invalidateCredentials('all')
    await expect(p.tokens()).resolves.toBeUndefined()
  })

  it('stages the verifier and authorization URL inside one attempt only', async () => {
    const ctx = await mountHost()
    const p = provider(ctx)
    expect(() => p.codeVerifier()).toThrow(/no OAuth code verifier is staged/)
    // Outside an attempt the staging members refuse or drop silently, so a
    // stray transport-driven run cannot fake interactive progress.
    await p.invalidateCredentials('verifier')
    await p.invalidateCredentials('discovery')
    expect(() => { p.redirectToAuthorization(new URL('http://as.example/authorize')) }).toThrow(McpAuthRequiredError)
    p.saveCodeVerifier('ignored')
    expect(() => p.codeVerifier()).toThrow(/no OAuth code verifier is staged/)
    p.beginAttempt(new URL('http://127.0.0.1:8917/callback'), 'a-state')
    p.saveCodeVerifier('the-verifier')
    expect(p.codeVerifier()).toBe('the-verifier')
    p.redirectToAuthorization(new URL('http://as.example/authorize'))
    expect(p.takeAuthorizationUrl()?.toString()).toBe('http://as.example/authorize')
    await p.invalidateCredentials('verifier')
    expect(() => p.codeVerifier()).toThrow(/no OAuth code verifier is staged/)
    p.saveDiscoveryState({ authorizationServerUrl: 'http://127.0.0.1:9' })
    expect(p.discoveryState()).toMatchObject({ authorizationServerUrl: 'http://127.0.0.1:9' })
    await p.invalidateCredentials('discovery')
    expect(p.discoveryState()).toBeUndefined()
    p.endAttempt()
    expect(p.takeAuthorizationUrl()).toBeUndefined()
  })

  it('fails loud on a malformed stored grant', async () => {
    const ctx = await mountHost()
    const store = ctx.get('credentials') as MemoryCredentials
    store.records.set(KEY, { kind: 'grant', payload: { tokens: { access_token: 42 } } })
    await expect(provider(ctx).tokens()).rejects.toThrow(/holds a malformed token set/)
    store.records.set(KEY, { kind: 'grant', payload: 'not an object' })
    await expect(provider(ctx).tokens()).rejects.toThrow(/holds a malformed grant payload/)
    store.records.set(KEY, { kind: 'grant', payload: { clientInformation: { client_name: 'no-id' } } })
    await expect(provider(ctx).tokens()).rejects.toThrow(/holds a malformed client registration/)
    store.records.set(KEY, { kind: 'api-key', key: 'k' })
    await expect(provider(ctx).tokens()).rejects.toThrow(/holds a malformed record/)
  })

  it('refuses reads and writes without a credentials service', async () => {
    const ctx = await mountHost(false)
    const p = provider(ctx)
    await expect(p.tokens()).rejects.toThrow(/mounts no\s+credentials service/)
    await expect(p.saveTokens({ access_token: 't', token_type: 'Bearer' })).rejects.toThrow(/credentials service/)
  })

  it('serves the connection role from the record and refuses what only a flow can do', async () => {
    const ctx = await mountHost()
    const p = provider(ctx, { kind: 'oauth' }, 'connection')
    // A truthy placeholder keeps the SDK's refresh path reachable; it is
    // never sent anywhere because this role refuses before registering.
    expect(p.redirectUrl.toString()).toBe('http://127.0.0.1/callback')
    await expect(p.clientInformation()).rejects.toBeInstanceOf(McpAuthRequiredError)
    // With a stored grant, the connection role serves reads and refreshes.
    await p.saveClientInformation({ client_id: 'as-issued' })
    await p.saveTokens({ access_token: 'token-1', token_type: 'Bearer', refresh_token: 'refresh-1' })
    await expect(p.clientInformation()).resolves.toEqual({ client_id: 'as-issued' })
    await expect(p.tokens()).resolves.toMatchObject({ access_token: 'token-1' })
    // A pre-registered client keeps the connection role usable with no
    // stored registration at all.
    const preRegistered = provider(ctx, { kind: 'oauth', clientId: 'static-id' }, 'connection')
    await expect(preRegistered.clientInformation()).resolves.toEqual({ client_id: 'static-id' })
  })
})

// ---- Interactive flow against the fixture authorization server ----

describe('MCP OAuth authorization flow', () => {
  it('walks discovery, registration, the browser redirect, and the code exchange', async () => {
    const ctx = await mountHost()
    const fixture = await startOAuthMcpFixture()
    const p = new McpOAuthProvider(ctx, flowOptions(fixture))
    registerMcpOAuthFlow(ctx, p)
    // The "browser": open the notified page; the redirect lands on the
    // loopback listener and leg two completes without any paste.
    const opened: PromiseWithResolvers<void> = Promise.withResolvers()
    const interaction = browserOnlyInteraction((url) => {
      void fetch(url).then(() => { opened.resolve() }, (error: unknown) => { opened.reject(error) })
    })
    const outcome = await Promise.all([ctx.authorization.begin({ key: KEY, interaction }), opened.promise])
    expect(outcome[0]).toEqual({ status: 'authorized' })
    await expect(p.tokens()).resolves.toMatchObject({ access_token: 'token-1', refresh_token: 'refresh-1' })
    expect(fixture.registrations).toHaveLength(1)
    expect(fixture.registrations[0]?.redirect_uris).toMatchObject([expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)])
    const exchange = fixture.tokenRequests.find(request => request.grant_type === 'authorization_code')
    expect(exchange?.code).toMatch(/^code-/)
    await fixture.close()
  })

  it('renews a stored grant through the refresh token without interaction', async () => {
    const ctx = await mountHost()
    const fixture = await startOAuthMcpFixture()
    const p = new McpOAuthProvider(ctx, flowOptions(fixture))
    registerMcpOAuthFlow(ctx, p)
    // First sign-in completes the browser walk so a grant exists to renew.
    const opened: PromiseWithResolvers<void> = Promise.withResolvers()
    const first = await Promise.all([
      ctx.authorization.begin({
        key: KEY,
        interaction: browserOnlyInteraction((url) => {
          void fetch(url).then(() => { opened.resolve() }, (error: unknown) => { opened.reject(error) })
        }),
      }),
      opened.promise,
    ])
    expect(first[0]).toEqual({ status: 'authorized' })
    const second = await ctx.authorization.begin({ key: KEY, interaction: neverAnswering() })
    expect(second).toEqual({ status: 'authorized' })
    await expect(p.tokens()).resolves.toMatchObject({ access_token: 'token-2' })
    expect(fixture.tokenRequests.some(request => request.grant_type === 'refresh_token')).toBe(true)
    await fixture.close()
  })

  it('accepts a pasted code when the browser cannot reach this machine', async () => {
    const ctx = await mountHost()
    const fixture = await startOAuthMcpFixture()
    const p = new McpOAuthProvider(ctx, flowOptions(fixture))
    registerMcpOAuthFlow(ctx, p)
    // Complete the authorization-server half by hand (follow nothing — the
    // loopback is deliberately absent), then paste the full callback URL: the
    // fixture advertises RFC 9207 `iss`, which a bare code cannot carry.
    const notifiedUrl = Promise.withResolvers<string>()
    const interaction: AuthorizationInteraction = {
      notify: (notice) => { if (notice.url !== undefined) notifiedUrl.resolve(notice.url) },
      prompt: async () => {
        const response = await fetch(await notifiedUrl.promise, { redirect: 'manual' })
        const location = response.headers.get('location')
        if (location === null) throw new Error('the fixture authorize endpoint did not redirect')
        return location
      },
    }
    const outcome = await ctx.authorization.begin({ key: KEY, interaction })
    expect(outcome).toEqual({ status: 'authorized' })
    await expect(p.tokens()).resolves.toMatchObject({ access_token: 'token-1' })
    await fixture.close()
  })

  it('refuses a pasted response from a different sign-in attempt', async () => {
    const ctx = await mountHost()
    const fixture = await startOAuthMcpFixture()
    const p = new McpOAuthProvider(ctx, flowOptions(fixture))
    registerMcpOAuthFlow(ctx, p)
    const interaction: AuthorizationInteraction = {
      notify: () => {},
      prompt: async () => 'http://127.0.0.1:1/callback?code=stolen&state=foreign',
    }
    await expect(ctx.authorization.begin({ key: KEY, interaction })).rejects.toThrow(/different sign-in attempt/)
    // A pasted bare query string gets the same binding check.
    const asQuery = { notify: () => {}, prompt: async () => 'code=stolen&state=foreign' }
    await expect(ctx.authorization.begin({ key: KEY, interaction: asQuery })).rejects.toThrow(/different sign-in attempt/)
    // A pasted bare query with no state binding parses to a bare code.
    const bareQuery = { notify: () => {}, prompt: async () => 'code=solo' }
    await expect(ctx.authorization.begin({ key: KEY, interaction: bareQuery })).rejects.toThrow()
    // A pasted callback URL with no code refuses before any exchange.
    const codeless = { notify: () => {}, prompt: async () => 'http://127.0.0.1:1/callback?state=x' }
    await expect(ctx.authorization.begin({ key: KEY, interaction: codeless })).rejects.toThrow(/contains no code/)
    await fixture.close()
  })

  it('refuses a bare pasted code against an issuer-binding authorization server', async () => {
    const ctx = await mountHost()
    const fixture = await startOAuthMcpFixture()
    const p = new McpOAuthProvider(ctx, flowOptions(fixture))
    registerMcpOAuthFlow(ctx, p)
    // The fixture advertises RFC 9207 `iss`, which a bare code cannot carry,
    // so the exchange refuses even though the paste parsed.
    const interaction: AuthorizationInteraction = {
      notify: () => {},
      prompt: async () => 'code-1',
    }
    await expect(ctx.authorization.begin({ key: KEY, interaction })).rejects.toThrow()
    await fixture.close()
  })

  it('fails the attempt when leg one cannot reach the authorization server', async () => {
    const ctx = await mountHost()
    const p = new McpOAuthProvider(ctx, {
      serverName: 'srv',
      serverUrl: 'http://127.0.0.1:9/mcp',
      auth: { kind: 'oauth' },
      key: KEY,
      role: 'flow',
    })
    registerMcpOAuthFlow(ctx, p)
    await expect(ctx.authorization.begin({ key: KEY, interaction: neverAnswering() })).rejects.toThrow()
  })

  it('settles a withdrawn attempt as cancelled', async () => {
    const ctx = await mountHost()
    const fixture = await startOAuthMcpFixture()
    const p = new McpOAuthProvider(ctx, flowOptions(fixture))
    registerMcpOAuthFlow(ctx, p)
    const notified: PromiseWithResolvers<void> = Promise.withResolvers()
    const controller = new AbortController()
    const attempt = ctx.authorization.begin({
      key: KEY,
      interaction: { notify: () => { notified.resolve() }, prompt: () => new Promise<string>(() => {}) },
      signal: controller.signal,
    })
    // Withdraw only once the flow is parked waiting for the callback, so no
    // authorization-server request is still in flight when the fixture closes.
    await notified.promise
    controller.abort()
    await expect(attempt).resolves.toEqual({ status: 'cancelled' })
    await fixture.close()
  })

  it('settles a mid-discovery withdrawal as cancelled', async () => {
    const ctx = await mountHost()
    const fixture = await startOAuthMcpFixture({ slowDiscoveryMs: 400 })
    const p = new McpOAuthProvider(ctx, flowOptions(fixture))
    registerMcpOAuthFlow(ctx, p)
    const controller = new AbortController()
    const attempt = ctx.authorization.begin({ key: KEY, interaction: neverAnswering(), signal: controller.signal })
    // Withdraw while leg one's discovery response is still in flight, so the
    // flow's abort race rejects the wrapped authorization run mid-await.
    await new Promise((resolve) => { setTimeout(resolve, 100) })
    controller.abort()
    await expect(attempt).resolves.toEqual({ status: 'cancelled' })
    // Let the orphaned discovery request finish against the still-open
    // fixture before the test closes it.
    await new Promise((resolve) => { setTimeout(resolve, 450) })
    await fixture.close()
  })

  it('reports a denied authorization as a failed attempt', async () => {
    const ctx = await mountHost()
    const fixture = await startOAuthMcpFixture()
    const p = new McpOAuthProvider(ctx, flowOptions(fixture))
    registerMcpOAuthFlow(ctx, p)
    // Complete discovery and registration normally, then answer the redirect
    // with the AS's refusal instead of a code.
    const interaction: AuthorizationInteraction = {
      notify: (notice) => {
        if (notice.url === undefined) return
        const redirectUri = new URL(notice.url).searchParams.get('redirect_uri')
        if (redirectUri === null) return
        // The attempt settles as soon as the refusal lands, and the listener
        // teardown may cut this response's body short — either way the
        // refusal was delivered.
        void fetch(`${redirectUri}?error=access_denied&error_description=nope`).catch(() => {})
      },
      prompt: () => new Promise<string>(() => {}),
    }
    await expect(ctx.authorization.begin({ key: KEY, interaction })).rejects.toThrow(/access_denied/)
    await fixture.close()
  })

  it('settles a declined paste prompt as cancelled', async () => {
    const ctx = await mountHost()
    const fixture = await startOAuthMcpFixture()
    const p = new McpOAuthProvider(ctx, flowOptions(fixture))
    registerMcpOAuthFlow(ctx, p)
    const interaction: AuthorizationInteraction = {
      notify: () => {},
      prompt: async () => { throw new AuthorizationDeclinedError() },
    }
    const outcome = await ctx.authorization.begin({ key: KEY, interaction })
    expect(outcome).toEqual({ status: 'cancelled' })
    await fixture.close()
  })
})

/** An interaction that ignores notices and never answers prompts. */
function neverAnswering(): AuthorizationInteraction {
  return {
    notify: () => {},
    prompt: () => new Promise<string>(() => {}),
  }
}

// ---- Loopback callback listener ----

describe('MCP OAuth callback listener', () => {
  it('captures a matching authorization response', async () => {
    const controller = new AbortController()
    const listener = await listenForCallback(0, 'expected-state', controller.signal)
    try {
      const response = await fetch(`${listener.redirectUrl}?code=the-code&state=expected-state&iss=http://as.example`)
      expect(response.status).toBe(200)
      await expect(listener.outcome).resolves.toEqual({
        status: 'code', code: 'the-code', iss: 'http://as.example',
      })
    } finally {
      await listener.close()
    }
  })

  it('captures an authorization response that carries no issuer parameter', async () => {
    const listener = await listenForCallback(0, 'expected-state', new AbortController().signal)
    try {
      const response = await fetch(`${listener.redirectUrl}?code=the-code&state=expected-state`)
      expect(response.status).toBe(200)
      await expect(listener.outcome).resolves.toEqual({ status: 'code', code: 'the-code' })
    } finally {
      await listener.close()
    }
  })

  it('settles an authorization-server refusal as denied', async () => {
    const controller = new AbortController()
    const listener = await listenForCallback(0, 'expected-state', controller.signal)
    try {
      const response = await fetch(`${listener.redirectUrl}?error=access_denied&error_description=nope`)
      expect(response.status).toBe(200)
      await expect(listener.outcome).resolves.toEqual({ status: 'denied', error: 'access_denied' })
    } finally {
      await listener.close()
    }
  })

  it('refuses a response that does not echo the attempt state', async () => {
    const controller = new AbortController()
    const listener = await listenForCallback(0, 'expected-state', controller.signal)
    try {
      const missing = await fetch(`${listener.redirectUrl}?code=the-code`)
      expect(missing.status).toBe(400)
      await expect(listener.outcome).resolves.toMatchObject({ status: 'denied' })
    } finally {
      await listener.close()
    }
    const foreign = await listenForCallback(0, 'expected-state', new AbortController().signal)
    try {
      const mismatched = await fetch(`${foreign.redirectUrl}?code=the-code&state=foreign`)
      expect(mismatched.status).toBe(400)
      await expect(foreign.outcome).resolves.toMatchObject({ status: 'denied' })
    } finally {
      await foreign.close()
    }
  })

  it('answers any other path with 404 without settling', async () => {
    const controller = new AbortController()
    const listener = await listenForCallback(0, 'expected-state', controller.signal)
    try {
      const response = await fetch(new URL('/elsewhere', listener.redirectUrl.origin))
      expect(response.status).toBe(404)
      let settled = false
      void listener.outcome.then(() => { settled = true })
      await new Promise(resolve => setTimeout(resolve, 25))
      expect(settled).toBe(false)
    } finally {
      await listener.close()
    }
  })

  it('settles as a timeout when the attempt withdraws', async () => {
    const controller = new AbortController()
    const listener = await listenForCallback(0, 'expected-state', controller.signal)
    controller.abort()
    await expect(listener.outcome).resolves.toEqual({ status: 'timeout' })
  })

  it('rejects when the callback port is already taken', async () => {
    const first = await listenForCallback(0, 'expected-state', new AbortController().signal)
    try {
      await expect(listenForCallback(
        Number(new URL(first.redirectUrl.toString()).port),
        'expected-state',
        new AbortController().signal,
      )).rejects.toThrow()
    } finally {
      await first.close()
    }
  })
})

// ---- Supervised connection path ----

describe('MCP OAuth supervised connection', () => {
  it('fails unauthorized, recovers when the flow commits a grant, and serves tool calls', async () => {
    const ctx = await mountHost()
    const fixture = await startOAuthMcpFixture()
    try {
      const errorLogger = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
      await apply(ctx, {
        transport: 'streamable-http',
        serverName: 'srv',
        url: fixture.url,
        auth: { kind: 'oauth' },
        headers: {},
        toolCallTimeoutMs: 5_000,
        failOnStartupError: false,
        reconnect: { enabled: true, initialDelayMs: 10, maxDelayMs: 100, maxAttempts: 100 },
      })
      // The unauthorized first attempt reports the action it needs at error
      // level and leaves the harness running with no tools registered.
      expect(errorLogger).toHaveBeenCalledWith(expect.stringMatching(/requires OAuth authorization/))
      expect(ctx.tools.get('mcp__srv__ping')).toBeUndefined()

      const opened: PromiseWithResolvers<void> = Promise.withResolvers()
      const interaction = browserOnlyInteraction((url) => {
        void fetch(url).then(() => { opened.resolve() }, (error: unknown) => { opened.reject(error) })
      })
      const outcome = await Promise.all([ctx.authorization.begin({ key: KEY, interaction }), opened.promise])
      expect(outcome[0]).toEqual({ status: 'authorized' })

      await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__ping')).toBeDefined() })
      // An in-flight 401 handler may refresh alongside the committed grant,
      // so any minted token is a valid final bearer here.
      expect(fixture.seenBearers.at(-1)).toMatch(/^Bearer token-\d+$/)
      const result = await callPing(ctx)
      expect(result).toBe('pong')
      errorLogger.mockRestore()
    } finally {
      await fixture.close()
    }
  })

  it('refreshes an expired access token mid-session without interaction', async () => {
    const ctx = await mountHost()
    const fixture = await startOAuthMcpFixture()
    try {
      vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
      vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
      await apply(ctx, {
        transport: 'streamable-http',
        serverName: 'srv',
        url: fixture.url,
        auth: { kind: 'oauth' },
        headers: {},
        toolCallTimeoutMs: 5_000,
        failOnStartupError: false,
        reconnect: { enabled: true, initialDelayMs: 10, maxDelayMs: 100, maxAttempts: 100 },
      })
      const opened: PromiseWithResolvers<void> = Promise.withResolvers()
      const interaction = browserOnlyInteraction((url) => {
        void fetch(url).then(() => { opened.resolve() }, (error: unknown) => { opened.reject(error) })
      })
      const outcome = await Promise.all([ctx.authorization.begin({ key: KEY, interaction }), opened.promise])
      expect(outcome[0]).toEqual({ status: 'authorized' })
      await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__ping')).toBeDefined() })
      expect(await callPing(ctx)).toBe('pong')

      // The stored access token dies; the next call must refresh and retry.
      fixture.revokeAccess()
      expect(await callPing(ctx)).toBe('pong')
      expect(fixture.seenBearers.at(-1)).toMatch(/^Bearer token-[2-9]$/)
      expect(fixture.tokenRequests.some(request => request.grant_type === 'refresh_token')).toBe(true)
    } finally {
      await fixture.close()
    }
  })
})

/** A connection config for the fixture, with a fast reconnect policy. */
function oauthConnectionConfig(url: string): Config {
  return {
    transport: 'streamable-http',
    serverName: 'srv',
    url,
    auth: { kind: 'oauth' },
    headers: {},
    toolCallTimeoutMs: 5_000,
    failOnStartupError: false,
    reconnect: { enabled: true, initialDelayMs: 5, maxDelayMs: 10, maxAttempts: 3 },
  }
}

describe('MCP OAuth connection nudge guards', () => {
  it('drops the nudge while an attempt is in flight', async () => {
    const ctx = await mountHost()
    const fixture = await startOAuthMcpFixture()
    try {
      vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
      const provider = new McpOAuthProvider(ctx, { ...flowOptions(fixture), role: 'connection' })
      // No grant stored: the launched attempt is still in flight when the
      // nudge arrives, so it is dropped without launching a second generation.
      const handle = startConnection(
        ctx,
        oauthConnectionConfig(fixture.url),
        resolveReconnectPolicy({ enabled: true, initialDelayMs: 5, maxDelayMs: 10, maxAttempts: 3 }, 'test'),
        provider,
      )
      handle.notifyAuthorized()
      const outcome = await handle.ready
      expect(outcome.error).toBeInstanceOf(McpAuthRequiredError)
      await handle.dispose()
    } finally {
      await fixture.close()
    }
  })

  it('revives a given-up server when a grant arrives', async () => {
    const ctx = await mountHost()
    const fixture = await startOAuthMcpFixture()
    try {
      const errorSpy = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
      const handle = startConnection(
        ctx,
        oauthConnectionConfig(fixture.url),
        resolveReconnectPolicy({ enabled: true, initialDelayMs: 5, maxDelayMs: 10, maxAttempts: 1 }, 'test'),
        new McpOAuthProvider(ctx, { ...flowOptions(fixture), role: 'connection' }),
      )
      const outcome = await handle.ready
      expect(outcome.error).toBeInstanceOf(McpAuthRequiredError)
      // The single allowed attempt is spent and its one retry too: wait for
      // the give-up itself, so no timer or attempt is still pending and only
      // the committed grant's nudge can bring the server back.
      await vi.waitFor(() => { expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/giving up after 1 consecutive failed/)) })
      const store = ctx.get('credentials') as MemoryCredentials
      store.records.set(KEY, {
        kind: 'grant',
        payload: {
          clientInformation: { client_id: 'fixture-client' },
          tokens: { access_token: 'token-0', token_type: 'Bearer', refresh_token: 'refresh-0' },
        },
      })
      handle.notifyAuthorized()
      await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__ping')).toBeDefined() })
      await handle.dispose()
    } finally {
      await fixture.close()
    }
  })

  it('drops the nudge while connected, with reconnect disabled, and after disposal', async () => {
    const ctx = await mountHost()
    const fixture = await startOAuthMcpFixture()
    try {
      // The fixture accepts its initial token before any flow mints another,
      // so a seeded grant connects without a sign-in.
      const store = ctx.get('credentials') as MemoryCredentials
      store.records.set(KEY, {
        kind: 'grant',
        payload: {
          clientInformation: { client_id: 'fixture-client' },
          tokens: { access_token: 'token-0', token_type: 'Bearer', refresh_token: 'refresh-0' },
        },
      })
      const provider = new McpOAuthProvider(ctx, { ...flowOptions(fixture), role: 'connection' })
      const handle = startConnection(ctx, oauthConnectionConfig(fixture.url), resolveReconnectPolicy(undefined, 'test'), provider)
      const outcome = await handle.ready
      expect(outcome.error).toBeUndefined()
      // Connected: the nudge is a no-op and the connection keeps serving.
      handle.notifyAuthorized()
      await handle.dispose()
      // Disposed: the nudge stays a no-op instead of resurrecting the supervisor.
      handle.notifyAuthorized()
      // Reconnect disabled: an unauthorized server refuses to be nudged.
      store.records.delete(KEY)
      const halted = startConnection(
        ctx,
        oauthConnectionConfig(fixture.url),
        resolveReconnectPolicy({ enabled: false }, 'test'),
        new McpOAuthProvider(ctx, { ...flowOptions(fixture), role: 'connection' }),
      )
      await halted.ready
      halted.notifyAuthorized()
      await halted.dispose()
    } finally {
      await fixture.close()
    }
  })
})

/** Execute the fixture's `ping` tool and return its text content. */
async function callPing(ctx: Context): Promise<string> {
  const result = await ctx.tools.execute({
    name: 'mcp__srv__ping',
    arguments: {},
    callId: ToolCallId('oauth-ping'),
    signal: new AbortController().signal,
  })
  if (result.isError) throw new Error(`ping failed: ${JSON.stringify(result.content)}`)
  const block = result.content[0]
  if (block === undefined || block.type !== 'text') throw new Error('ping returned no text block')
  return block.text
}
