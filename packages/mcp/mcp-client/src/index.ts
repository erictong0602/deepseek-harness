/**
 * MCP client bridge plugin: connects to an external MCP server and registers
 * its tools on `ctx.tools` under server-qualified public names
 * (`mcp__<serverName>__<rawName>`). Each plugin instance connects to one MCP
 * server; load multiple instances in `cordis.yml` for multiple servers.
 *
 * Namespace plugin (named exports, no default export). Lifecycle is
 * effect-scoped: disposal disconnects from the server, unregisters all tools,
 * and releases the `serverName` namespace reservation. HMR hot-swaps by
 * disposing the old instance and creating a new one; identical `serverName`
 * reproduces identical public tool names.
 *
 * @module @deepseek-ai/dsh-mcp-client
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { isCredentialKeySegment } from '@deepseek-ai/dsh-credentials'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { DEFAULT_MAX_INSTRUCTION_BYTES, RECONNECT_DEFAULTS, resolveReconnectPolicy, startConnection } from './connection.ts'
import type { ReconnectConfig } from './connection.ts'
import { McpOAuthProvider, mcpOAuthRecordId, mcpOAuthRecordKey, registerMcpOAuthFlow } from './auth.ts'
import type { McpOAuthOptions, OAuthAuthConfig } from './auth.ts'
import { registerServerContext } from './server-context.ts'
// Side-effect type import: declaration-merges `ctx.tools` onto Context.
import type {} from '@deepseek-ai/dsh-tools'

export { createMcpToolDefinition } from './tools.ts'
export type { McpResult, McpToolDefinitionOptions } from './tools.ts'
export type { ReconnectConfig, ResolvedReconnectPolicy } from './connection.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'mcp-client'

/** Services required by this plugin. */
export const inject = ['tools']

/** Default timeout for individual MCP tool calls and resource requests (ms). */
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000

/** Valid `serverName`, kept below the public tool-name budget. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/**
 * Live `serverName` reservations per registration scope. Agent-scoped MCP
 * servers may reuse a namespace in another Agent, while global instances and
 * duplicates inside one Agent remain mutually exclusive.
 */
const activeServerNames = new WeakMap<object, Set<string>>()

/**
 * Live OAuth grant-record ids per registration scope, mapped to the server
 * name that claimed them. Server names are unique per scope by exact string,
 * but the record grammar is lowercase — two configured names that fold onto
 * one record id would silently share one grant, so the second fails at load.
 */
const activeOAuthRecordIds = new WeakMap<object, Map<string, string>>()

/** The role-independent facts both OAuth providers for one server share. */
type McpOAuthFacts = Omit<McpOAuthOptions, 'role'>

/**
 * Resolve one Streamable HTTP server's `auth` configuration into the shared
 * facts its two OAuth providers are built from. This is the explicit resolve
 * step for the auth seam: it fails THIS instance at load when the server name
 * cannot address a credential record or when another live instance already
 * owns the folded record id.
 *
 * @param ctx - plugin context, for the scope that owns the reservation.
 * @param config - resolved streamable-http configuration.
 * @returns the provider facts, or undefined without `auth`.
 */
function resolveOAuthOptions(ctx: Context, config: StreamableHttpConfig): McpOAuthFacts | undefined {
  const { auth } = config
  if (auth === undefined) return undefined
  if (auth.scopes !== undefined) {
    for (const scope of auth.scopes) {
      if (scope.trim() === '') throw new Error(`mcp-client(${config.serverName}): auth.scopes entries must be non-empty`)
    }
  }
  const recordId = mcpOAuthRecordId(config.serverName)
  if (!isCredentialKeySegment(recordId)) {
    throw new Error(
      `mcp-client(${config.serverName}): auth oauth needs a serverName whose lowercase form addresses a credential`
      + ' record — start the name with a letter and use only letters, digits, hyphens, and underscores',
    )
  }
  const owner = scopeOf(ctx) ?? ctx.root
  let claimed = activeOAuthRecordIds.get(owner)
  if (claimed === undefined) {
    claimed = new Map()
    activeOAuthRecordIds.set(owner, claimed)
  }
  const holder = claimed.get(recordId)
  if (holder !== undefined) {
    throw new Error(
      `mcp-client(${config.serverName}): serverName "${holder}" already addresses OAuth credential record`
      + ` "${recordId}" — pick a serverName whose lowercase form is unique`,
    )
  }
  claimed.set(recordId, config.serverName)
  ctx.effect(() => () => { claimed.delete(recordId) }, 'mcp-client.oauthRecordId')
  return {
    serverName: config.serverName,
    serverUrl: config.url,
    auth,
    key: mcpOAuthRecordKey(config.serverName),
  }
}

// ---- Config ----

/** Config for connecting to an MCP server via a spawned child process over stdio. */
export interface StdioConfig {
  /** Selects child-process stdio transport. */
  transport: 'stdio'
  /**
   * Stable local namespace for this server's model-facing tool names
   * (`mcp__<serverName>__<rawName>`). Must match `[A-Za-z0-9_-]{1,32}` and be
   * unique across live mcp-client instances.
   */
  serverName: string
  /** Executable used to start the server. */
  command: string
  /** Arguments passed directly, without shell interpolation. */
  args: string[]
  /** Extra env vars merged on top of scrubbed ambient env. */
  env: Record<string, string>
  /** Working directory for the child process. */
  cwd: string
  /** Timeout per tool call or resource request in milliseconds. */
  toolCallTimeoutMs: number
  /** Fail plugin activation when the initial connection or tool synchronization fails. */
  failOnStartupError: boolean
  /** Maximum UTF-8 bytes of attributed server instructions (default 32768). */
  maxInstructionBytes?: number
  /** Automatic reconnect policy after a lost connection; omission uses the defaults. */
  reconnect?: ReconnectConfig
}

/** Config for connecting to an MCP server over Streamable HTTP (SSE). */
export interface StreamableHttpConfig {
  /** Selects Streamable HTTP transport. */
  transport: 'streamable-http'
  /**
   * Stable local namespace for this server's model-facing tool names
   * (`mcp__<serverName>__<rawName>`). Must match `[A-Za-z0-9_-]{1,32}` and be
   * unique across live mcp-client instances.
   */
  serverName: string
  /** MCP endpoint URL. */
  url: string
  /** Additional headers attached to MCP requests. */
  headers: Record<string, string>
  /**
   * OAuth authorization against the server's authorization server; omission
   * sends only `headers`. Requires the credentials service; authorize the
   * stored grant from a settings surface before the server accepts requests.
   */
  auth?: OAuthAuthConfig
  /** Timeout per tool call or resource request in milliseconds. */
  toolCallTimeoutMs: number
  /** Fail plugin activation when the initial connection or tool synchronization fails. */
  failOnStartupError: boolean
  /** Maximum UTF-8 bytes of attributed server instructions (default 32768). */
  maxInstructionBytes?: number
  /** Automatic reconnect policy after a lost connection; omission uses the defaults. */
  reconnect?: ReconnectConfig
}

/** Configuration for one stdio or Streamable HTTP MCP server. */
export type Config = StdioConfig | StreamableHttpConfig

type StdioConfigInput = Omit<StdioConfig, 'args' | 'env' | 'cwd' | 'toolCallTimeoutMs' | 'failOnStartupError'>
  & Partial<Pick<StdioConfig, 'args' | 'env' | 'cwd' | 'toolCallTimeoutMs' | 'failOnStartupError'>>
type StreamableHttpConfigInput = Omit<StreamableHttpConfig, 'headers' | 'toolCallTimeoutMs' | 'failOnStartupError'>
  & Partial<Pick<StreamableHttpConfig, 'headers' | 'toolCallTimeoutMs' | 'failOnStartupError'>>
type ConfigInput = StdioConfigInput | StreamableHttpConfigInput

const Reconnect: z<ReconnectConfig> = z.object({
  enabled: z.boolean().default(RECONNECT_DEFAULTS.enabled),
  initialDelayMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(RECONNECT_DEFAULTS.initialDelayMs),
  maxDelayMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(RECONNECT_DEFAULTS.maxDelayMs),
  maxAttempts: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(RECONNECT_DEFAULTS.maxAttempts),
})

/** OAuth authorization options; every member except the kind is optional. */
const OAuthAuth: z<OAuthAuthConfig> = z.object({
  kind: z.const('oauth'),
  scopes: z.array(z.string()),
  clientName: z.string(),
  clientId: z.string(),
  clientSecret: z.string(),
  callbackPort: z.number().step(1).min(1).max(65535),
})

export const Config = z.union([
  z.object({
    transport: z.const('stdio'),
    serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
    command: z.string().required(),
    args: z.array(String).default([]),
    env: z.dict(String).default({}),
    cwd: z.string().default(''),
    toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
    failOnStartupError: z.boolean().default(false),
    maxInstructionBytes: z.number().step(1).min(1).default(DEFAULT_MAX_INSTRUCTION_BYTES),
    reconnect: Reconnect,
  }),
  z.object({
    transport: z.const('streamable-http'),
    serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
    url: z.string().required(),
    headers: z.dict(String).default({}),
    auth: z.union([OAuthAuth, z.const(undefined)]),
    toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
    failOnStartupError: z.boolean().default(false),
    maxInstructionBytes: z.number().step(1).min(1).default(DEFAULT_MAX_INSTRUCTION_BYTES),
    reconnect: Reconnect,
  }),
]) as z<ConfigInput, Config>

// ---- Plugin apply ----

/**
 * Connect one MCP server and publish its initial tool generation before activation.
 * This entry remains explicitly `async`: Cordis treats a prototype-bearing
 * ordinary function as a constructor, whose returned Promise is not startup work.
 * @param ctx - plugin context carrying the tool registry.
 * @param config - resolved transport and server namespace configuration.
 * @returns startup readiness after connection and initial tool discovery settle.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  // Fail loud at load: reconnect misconfiguration (including programmatic
  // construction that bypassed Schemastery) rejects THIS instance before any
  // effect registers.
  const reconnect = resolveReconnectPolicy(config.reconnect, `mcp-client(${config.serverName}): reconnect`)

  // Reserve the namespace next: a duplicate `serverName` fails THIS instance
  // at load with an actionable error and leaves the earlier instance intact.
  ctx.effect(() => {
    const owner = scopeOf(ctx) ?? ctx.root
    let names = activeServerNames.get(owner)
    if (!names) {
      names = new Set()
      activeServerNames.set(owner, names)
    }
    if (names.has(config.serverName)) {
      throw new Error(
        `mcp-client: serverName "${config.serverName}" is already in use by another mcp-client instance — pick a unique serverName in cordis.yml`,
      )
    }
    names.add(config.serverName)
    return () => void names.delete(config.serverName)
  }, 'mcp-client.serverName')

  // The supervisor owns the client/transport generations, the reconnect
  // loop, and the live tool registrations; disposal stops reconnection,
  // quiesces in-flight work, and unregisters the current generation.
  const oauth = config.transport === 'streamable-http' ? resolveOAuthOptions(ctx, config) : undefined
  const connection = startConnection(
    ctx,
    config,
    reconnect,
    oauth === undefined ? undefined : new McpOAuthProvider(ctx, { ...oauth, role: 'connection' }),
  )
  registerServerContext(ctx, config.serverName, connection)
  // OAuth sign-in is offered wherever a surface can run it: the flow exists
  // from the moment an OAuth server is configured, while a composition
  // without the authorization seam (headless, ACP) simply has no surface to
  // sign in from — the connection still works once a grant is stored. The
  // flow's provider is its own instance sharing only the record, so a
  // reconnect attempt racing the sign-in cannot overwrite its staging.
  if (oauth !== undefined) {
    ctx.inject(['authorization'], (authorized) => {
      registerMcpOAuthFlow(authorized, new McpOAuthProvider(authorized, { ...oauth, role: 'flow' }), {
        onAuthorized: () => { connection.notifyAuthorized() },
      })
    })
  }
  let stopping: Promise<void> | undefined
  const dispose = (): Promise<void> => stopping ??= connection.dispose()
  // Cordis announces unload before awaiting an unfinished apply(). Closing
  // the transport here releases startup requests that are still awaiting a reply.
  // oxlint-disable-next-line typescript/no-misused-promises -- Cordis contains observer failures; the effect also awaits this promise.
  ctx.on('internal/plugin', (fiber) => {
    if (fiber !== ctx.fiber || fiber.uid !== null) return
    return dispose()
  }, { global: true })
  ctx.effect(() => dispose, 'mcp-client.connection')

  // Block plugin activation on the initial connection + tool discovery so
  // Cordis consumers observe the tools immediately after the fiber activates.
  // When failOnStartupError is true, a failed initial attempt rejects the
  // fiber (Cordis rolls it back); otherwise the error is logged and the
  // supervisor enters its reconnect loop.
  const outcome = await connection.ready
  if (outcome.error !== undefined && config.failOnStartupError) {
    throw new Error(`mcp-client(${config.serverName}): initial connection or tool synchronization failed`, { cause: outcome.error })
  }
}
