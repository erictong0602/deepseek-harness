/**
 * Astria CLI backend for `ctx.codegraph`. One plugin instance resolves the astria executable at
 * load, registers the sole provider, and answers every seam query with one complete child-process
 * run through `ctx.subprocess` — so local and remote execution worlds share one host. Deploys must
 * install astria and build the workspace graph (`astria run .`); this package ships neither.
 *
 * Namespace plugin (named exports, no default export). Lifecycle is effect-scoped: disposal
 * unregisters from `ctx.codeGraph` and awaits every in-flight child.
 * @module @deepseek-ai/dsh-astria
 */

import type { Context } from '@deepseek-ai/cordis'
import { refreshJobHooks } from '@deepseek-ai/dsh-codegraph'
import type {
  CodeGraphQueryRequest,
  CodeGraphService,
} from '@deepseek-ai/dsh-codegraph'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { AstriaEngine, AstriaSemanticSpec } from './args.ts'
import { AstriaCliProvider } from './provider.ts'
import type { AstriaProviderSpec, AstriaSpawner } from './provider.ts'
import { AstriaServerProvider } from './server-provider.ts'
import type { AstriaServerSpec } from './server.ts'

/** The closed backend selection: `plain` structural extraction or one LLM engine. */
export type AstriaBackend = 'plain' | AstriaEngine

// Type-only: the compaction events the orientation listener reacts to are declared by this
// package's SessionEventMap merge.
import type {} from '@deepseek-ai/dsh-compaction'

export { buildAstriaArgs, buildAstriaRefreshArgs } from './args.ts'
export type { AstriaEngine, AstriaSemanticSpec } from './args.ts'
export { AstriaCliProvider } from './provider.ts'
export type { AstriaProviderSpec, AstriaSpawner } from './provider.ts'
export { AstriaServerProvider } from './server-provider.ts'
export { AstriaMcpServer, mcpToolCall } from './server.ts'
export type { AstriaServerSpec, McpServedQuery, McpToolCall } from './server.ts'
export { parseAstriaStatus, renderAstriaStatus } from './status.ts'
export type { AstriaStatusFacts } from './status.ts'

/** This producer's job kind on `ctx.jobs` (background graph refreshes). */
declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    codegraph: 'codegraph'
  }
}

/** This producer's message-source kind for graph-refresh notices the owning agent receives. */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * One background graph refresh landed; the notice only attributes the injected user message.
     * @persistenceAttribution
     */
    astria: { kind: 'astria' }
  }
}

/** Cordis plugin name for loader diagnostics. */
export const name = 'astria'

/** Services required by this plugin. */
export const inject = ['subprocess', 'codeGraph']

const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000
const DEFAULT_MAX_STDERR_BYTES = 100_000
const DEFAULT_KILL_GRACE_MS = 2_000
const DEFAULT_AUTO_UPDATE_DEBOUNCE_MS = 3_000
const DEFAULT_SERVER_TIMEOUT_MS = 30_000

/**
 * Internal best-effort bound for the load-time `astria --version` diagnostic; the probe never gates
 * startup, so it is a fixed protocol-style constant rather than deployment configuration.
 */
const VERSION_PROBE_TIMEOUT_MS = 10_000

/** File-mutating tool names that trigger a debounced incremental refresh. */
export const DEFAULT_AUTO_UPDATE_TOOLS: readonly string[] = ['write', 'edit', 'str_replace_editor']

/** Blast-radius context attached after watched edit tools; enabled deployments only. */
export interface EditContextConfig {
  /** After a successful watched edit, query the graph and attach the blast radius as context. */
  enabled?: boolean
  /** Tool names that count as edits. Default write, edit, str_replace_editor. */
  tools?: string[]
  /** Largest attached blast-radius context in characters. Default 2000. */
  maxChars?: number
}

/** Repository-map orientation injected after compaction; enabled deployments only. */
export interface OrientationConfig {
  /** After a compaction/end event, inject one token-budgeted repo map for the session's agent. */
  enabled?: boolean
  /** The repo map's token budget. Default 1000. */
  budgetTokens?: number
}

/**
 * The Jev judge layer (astria ≥ 1.0.7): TypeSafe System One re-judges the engine's extractions,
 * gates trivial files before they cost engine calls, and attaches calibrated edge confidence.
 * Presence enables the layer; it requires an engine backend.
 */
export interface JudgeConfig {
  /** Judge API key, forwarded as `ASTRIA_LLM_JUDGE_API_KEY` (`TYPESAFE_API_KEY` also honored). */
  apiKey?: string
  /** Judge model, forwarded as `ASTRIA_LLM_JUDGE_MODEL`; upstream default `jev-latest`. */
  model?: string
  /** Per-file verification pass re-choosing node types and edge verdicts; upstream default on. */
  verify?: boolean
  /** Keep-probability floor (0–1) below which a semantic edge is dropped; upstream default 0.40. */
  minEdgeProbability?: number
  /** Batched trivial-file gate before first extraction; upstream default on. */
  gate?: boolean
  /** Files above this size (bytes) are presumed rich and skip gate batching; upstream default 65536. */
  gateMaxBytes?: number
  /** Judge keep-score (0–1) at or below which a gated file is dropped; upstream default 0.40. */
  gateDropThreshold?: number
  /** Files per gate batch, bounding request fan-out; upstream default 50. */
  gateBatch?: number
}

/** Debounced post-edit graph refresh; active wherever a job registry and the tool runtime are composed. */
export interface AutoUpdateConfig {
  /** Listen for file-mutating tool results and refresh the graph. Default true. */
  enabled?: boolean
  /** Quiet window after the last edit before the refresh job starts (ms). Default 3000. */
  debounceMs?: number
  /** Tool names that count as edits. Default write, edit, str_replace_editor. */
  tools?: string[]
}

/** Plugin configuration: the astria executable, its host bounds, semantic extraction, and post-edit refresh. */
export interface Config {
  /** Executable to run (absolute, or a bare name resolved on the scrubbed PATH at load). Default `astria`. */
  command?: string
  /** Extra global arguments inserted before the operation subcommand. Default `[]`. */
  args?: string[]
  /** Extra env vars merged on top of the scrubbed ambient env. Default `{}`. */
  env?: Record<string, string>
  /** In-memory cap for collected stdout per query (bytes); overflow keeps the tail. Default 1000000. */
  maxOutputBytes?: number
  /** In-memory cap for collected stderr per query (bytes); overflow keeps the tail. Default 100000. */
  maxStderrBytes?: number
  /** Termination grace for cancelled or disposed queries (ms). Default 2000. */
  killGraceMs?: number
  /**
   * Query transport: `cli` runs one astria child per query (default); `server` keeps one pooled
   * `astria mcp` stdio child per workspace root and answers queries through it. Load rejects any
   * other value.
   */
  transport?: string
  /** MCP handshake and per-call budget for the `server` transport (ms). Default 30000. */
  serverTimeoutMs?: number
  /** Debounced incremental refresh after file-mutating tools. Default enabled. */
  autoUpdate?: AutoUpdateConfig
  /** Blast-radius context after watched edits. Default disabled. */
  editContext?: EditContextConfig
  /** Repository-map orientation after compaction. Default disabled. */
  orientation?: OrientationConfig
  /**
   * Semantic-extraction engine (astria ≥ 1.0.7): `claude`, `openai` (any OpenAI-compatible
   * endpoint), or `gemini`; `plain` (default) keeps structural extraction with no LLM. Selected
   * engine runs ride `--backend` on every build and update.
   */
  backend?: string
  /** Backend-specific model name passed as `--model` on build and update runs. */
  model?: string
  /** Engine API key forwarded as `ASTRIA_LLM_API_KEY`; the scrubbed ambient env drops KEY-named vars. */
  apiKey?: string
  /** OpenAI-compatible endpoint base URL forwarded as `ASTRIA_LLM_BASE_URL`; openai backend only. */
  baseUrl?: string
  /** Total LLM token budget for a run, forwarded as `ASTRIA_LLM_BUDGET`; 0 means unlimited. */
  tokenBudget?: number
  /** Local embedding pass (`--embed`): `similar_to` edges and semantic query recall; no backend needed. */
  embed?: boolean
  /** Thematic community naming (`--label-communities`), one call per changed community; needs a backend. */
  labelCommunities?: boolean
  /** Cross-file concept-link tier (`--deep`), one call per changed file; needs a backend. */
  deep?: boolean
  /** The Jev judge layer over the selected engine; presence enables it, and it requires a backend. */
  judge?: JudgeConfig
}

const AutoUpdateConfig: z<AutoUpdateConfig> = z.object({
  enabled: z.boolean().default(true),
  debounceMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_AUTO_UPDATE_DEBOUNCE_MS),
  tools: z.array(String).default([...DEFAULT_AUTO_UPDATE_TOOLS]),
})

const EditContextConfig: z<EditContextConfig> = z.object({
  enabled: z.boolean().default(false),
  tools: z.array(String).default([...DEFAULT_AUTO_UPDATE_TOOLS]),
  maxChars: z.number().default(2_000),
})

const OrientationConfig: z<OrientationConfig> = z.object({
  enabled: z.boolean().default(false),
  budgetTokens: z.number().default(1_000),
})

const JudgeConfig: z<JudgeConfig> = z.object({
  apiKey: z.string(),
  model: z.string(),
  verify: z.boolean(),
  minEdgeProbability: z.number().min(0).max(1),
  gate: z.boolean(),
  gateMaxBytes: z.number(),
  gateDropThreshold: z.number().min(0).max(1),
  gateBatch: z.number(),
})

export const Config: z<Config> = z.object({
  command: z.string().default('astria'),
  args: z.array(String).default([]),
  env: z.dict(String).default({}),
  maxOutputBytes: z.number().default(DEFAULT_MAX_OUTPUT_BYTES),
  maxStderrBytes: z.number().default(DEFAULT_MAX_STDERR_BYTES),
  killGraceMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_KILL_GRACE_MS),
  transport: z.string().default('cli'),
  serverTimeoutMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_SERVER_TIMEOUT_MS),
  autoUpdate: AutoUpdateConfig.default({
    enabled: true,
    debounceMs: DEFAULT_AUTO_UPDATE_DEBOUNCE_MS,
    tools: [...DEFAULT_AUTO_UPDATE_TOOLS],
  }),
  editContext: EditContextConfig.default({ enabled: false, tools: [...DEFAULT_AUTO_UPDATE_TOOLS], maxChars: 2_000 }),
  orientation: OrientationConfig.default({ enabled: false, budgetTokens: 1_000 }),
  backend: z.string().default('plain'),
  model: z.string(),
  apiKey: z.string(),
  baseUrl: z.string(),
  tokenBudget: z.number(),
  embed: z.boolean().default(false),
  labelCommunities: z.boolean().default(false),
  deep: z.boolean().default(false),
  judge: JudgeConfig,
})

/** One plugin config after schemastery fills every default. */
type ResolvedConfig = Required<Omit<Config, 'autoUpdate' | 'transport' | 'editContext' | 'orientation' | 'judge'>> & {
  transport: 'cli' | 'server'
  autoUpdate: Required<AutoUpdateConfig>
  editContext: Required<EditContextConfig>
  orientation: Required<OrientationConfig>
  judge: JudgeConfig | undefined
}

/** The semantic-extraction surface one provider resolved from its configuration. */
interface SemanticResolution {
  readonly semantic: AstriaSemanticSpec
  readonly llmEnv: Readonly<Record<string, string>>
  readonly extractionLabel: string
}

/**
 * Validate the backend selection and resolve the semantic-extraction surface: the refresh flags,
 * the derived environment entries, and the status-report label. Fails loud at load on every
 * combination astria would reject mid-run — a judge or an LLM tier without an engine, an openai-only
 * base URL under another engine, or a malformed budget or gate knob.
 * @param config - the resolved plugin configuration.
 * @returns the semantic flags, environment entries, and extraction label for the provider spec.
 */
function resolveSemantic(config: ResolvedConfig): SemanticResolution {
  const backend = parseBackend(config.backend)
  // schemastery materializes an unset object field as `{}`; an empty judge block means no judge.
  const judge = config.judge !== undefined && Object.keys(config.judge).length > 0 ? config.judge : undefined
  if (backend === 'plain') {
    if (judge !== undefined) {
      throw new Error('astria: judge requires an engine backend (the judge wraps an engine; it cannot generate extractions) — set backend to claude, openai, or gemini')
    }
    if (config.labelCommunities || config.deep) {
      throw new Error('astria: labelCommunities and deep require an engine backend — set backend to claude, openai, or gemini')
    }
  }
  if (config.baseUrl !== undefined && backend !== 'openai') {
    throw new Error('astria: baseUrl is the OpenAI-compatible endpoint and applies to the openai backend only')
  }
  if (config.tokenBudget !== undefined && (!Number.isInteger(config.tokenBudget) || config.tokenBudget < 0)) {
    throw new Error('astria: tokenBudget must be a non-negative integer')
  }
  if (judge !== undefined) {
    if (judge.gateMaxBytes !== undefined) assertPositiveInteger('judge.gateMaxBytes', judge.gateMaxBytes)
    if (judge.gateBatch !== undefined) assertPositiveInteger('judge.gateBatch', judge.gateBatch)
  }

  const semantic: AstriaSemanticSpec = backend === 'plain'
    ? { embed: config.embed }
    : {
      backend,
      ...config.model !== undefined ? { model: config.model } : {},
      ...judge !== undefined ? { judge: true } : {},
      embed: config.embed,
      labelCommunities: config.labelCommunities,
      deep: config.deep,
    }
  const env: Record<string, string> = {
    // Selection is deterministic: the empty value disables enrichment and the
    // judge even when the ambient environment carries a selection (astria reads
    // an empty or `none` backend as "no engine").
    ASTRIA_LLM_BACKEND: backend === 'plain' ? '' : backend,
    ASTRIA_LLM_JUDGE: judge !== undefined ? 'jev' : '',
  }
  if (config.apiKey !== undefined) env.ASTRIA_LLM_API_KEY = config.apiKey
  if (config.baseUrl !== undefined) env.ASTRIA_LLM_BASE_URL = config.baseUrl
  if (config.model !== undefined) env.ASTRIA_LLM_MODEL = config.model
  if (config.tokenBudget !== undefined) env.ASTRIA_LLM_BUDGET = String(config.tokenBudget)
  if (judge !== undefined) {
    if (judge.apiKey !== undefined) env.ASTRIA_LLM_JUDGE_API_KEY = judge.apiKey
    if (judge.model !== undefined) env.ASTRIA_LLM_JUDGE_MODEL = judge.model
    if (judge.verify !== undefined) env.ASTRIA_LLM_JEV_VERIFY = judge.verify ? '1' : '0'
    if (judge.minEdgeProbability !== undefined) env.ASTRIA_LLM_JEV_MIN_EDGE_PROBABILITY = String(judge.minEdgeProbability)
    if (judge.gate !== undefined) env.ASTRIA_LLM_JEV_GATE = judge.gate ? '1' : '0'
    if (judge.gateMaxBytes !== undefined) env.ASTRIA_LLM_JEV_GATE_MAX_BYTES = String(judge.gateMaxBytes)
    if (judge.gateDropThreshold !== undefined) env.ASTRIA_LLM_JEV_GATE_DROP_THRESHOLD = String(judge.gateDropThreshold)
    if (judge.gateBatch !== undefined) env.ASTRIA_LLM_JEV_GATE_BATCH = String(judge.gateBatch)
  }
  const extractionLabel = backend === 'plain'
    ? config.embed ? 'plain + local embeddings' : 'plain'
    : `${backend}${judge !== undefined ? ' + jev judge' : ''}`
  return { semantic, llmEnv: env, extractionLabel }
}

/** Narrow the configured backend string to the closed selection, failing loud on anything else. */
function parseBackend(backend: string): AstriaBackend {
  if (backend === 'plain' || backend === 'claude' || backend === 'openai' || backend === 'gemini') return backend
  throw new Error(`astria: backend must be plain, claude, openai, or gemini, got ${JSON.stringify(backend)}`)
}

/**
 * Resolve the executable and register the sole provider. A missing or unresolvable command rejects
 * activation, so a broken deployment fails loud at load instead of per query.
 * @param ctx - the plugin context carrying `subprocess` and `codeGraph`.
 * @param config - the resolved plugin configuration (schemastery has filled every default).
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = config as ResolvedConfig
  assertPositiveInteger('maxOutputBytes', resolved.maxOutputBytes)
  assertPositiveInteger('maxStderrBytes', resolved.maxStderrBytes)
  assertTimer('killGraceMs', resolved.killGraceMs)
  assertTimer('serverTimeoutMs', resolved.serverTimeoutMs)
  if (config.transport !== undefined && config.transport !== 'cli' && config.transport !== 'server') {
    throw new Error(`astria: transport must be "cli" or "server", got ${JSON.stringify(config.transport)}`)
  }
  const { semantic, llmEnv, extractionLabel } = resolveSemantic(resolved)

  const setupAbort = new AbortController()
  // `internal/plugin` is a declared built-in Cordis event (a fiber's uid was cleared on disposal);
  // it is the only mechanism to observe this plugin's own unload while `apply` still awaits the
  // executable, because Cordis runs effect cleanup only after an async callback returns. Aborting
  // here lets unload proceed without waiting for the pending activation. Resolution stays eager:
  // moving it to the first query would trade the load-time "missing executable rejects activation"
  // contract for a per-query surprise.
  const stopSetupCancellation = ctx.on('internal/plugin', (fiber) => {
    if (fiber === ctx.fiber && fiber.uid === null) {
      setupAbort.abort(new Error('astria setup disposed'))
    }
  })

  let executable: string
  try {
    executable = await ctx.subprocess.resolveExecutable(resolved.command, resolved.env, setupAbort.signal)
    setupAbort.signal.throwIfAborted()
  } finally {
    stopSetupCancellation()
  }

  const spec: AstriaProviderSpec = {
    executable,
    args: resolved.args,
    env: resolved.env,
    llmEnv,
    semantic,
    extractionLabel,
    maxOutputBytes: resolved.maxOutputBytes,
    maxStderrBytes: resolved.maxStderrBytes,
    killGraceMs: resolved.killGraceMs,
  }
  const spawner: AstriaSpawner = spawnSpec => ctx.subprocess.spawn(spawnSpec)
  await probeVersion(ctx, spec)
  const provider: Pick<AstriaCliProvider, 'id' | 'query' | 'refresh' | 'dispose'> = resolved.transport === 'server'
    ? new AstriaServerProvider(new AstriaCliProvider(spec, spawner), {
      executable,
      args: resolved.args,
      env: resolved.env,
      callTimeoutMs: resolved.serverTimeoutMs,
      killGraceMs: resolved.killGraceMs,
      maxStderrBytes: resolved.maxStderrBytes,
    } satisfies AstriaServerSpec, spawner)
    : new AstriaCliProvider(spec, spawner)

  ctx.effect(() => {
    // Remove the provider before child teardown so no new query can enter a draining provider.
    const dispose = ctx.codeGraph.registerProvider(provider)
    return async () => {
      dispose()
      await provider.dispose()
    }
  }, 'astria.registerProvider')

  if (resolved.autoUpdate.enabled) {
    // Both services are optional to this plugin: the listener activates only where a job registry
    // and the tool runtime are composed, so a minimal query-only deployment stays unchanged.
    ctx.inject(['jobs', 'tools'], (scoped) => {
      const watched = new Set(resolved.autoUpdate.tools)
      const timers = new Map<string, ReturnType<typeof setTimeout>>()
      scoped.effect(() => () => {
        // The map dies with the scope; only the pending timers need explicit clearing.
        for (const pending of timers.values()) clearTimeout(pending)
      }, 'astria.autoUpdate.timers')

      scoped.on('tools/post-execute', async (exec, result, next) => {
        const decision = await next()
        const agent = exec.agent
        const root = agent?.session.header.cwd
        if (agent !== undefined && root !== undefined && !result.isError && watched.has(exec.name)) {
          const pending = timers.get(root)
          if (pending !== undefined) clearTimeout(pending)
          timers.set(root, setTimeout(() => {
            timers.delete(root)
            try {
              startUpdateJob(scoped.jobs, provider, root, agent)
            } catch (error) {
              // Registry admission (a job limit, a missing controller) must never escape a timer.
              scoped.logger.warn(`astria: starting the automatic graph update failed: ${String(error)}`)
            }
          }, resolved.autoUpdate.debounceMs))
        }
        return decision
      })
    })
  }

  if (resolved.editContext.enabled) {
    ctx.inject(['tools'], (scoped) => {
      const watched = new Set(resolved.editContext.tools)
      scoped.on('tools/post-execute', async (exec, result, next) => {
        const decision = await next()
        try {
          const agent = exec.agent
          const root = agent?.session.header.cwd
          const path = pathOfEdit(exec.arguments)
          if (agent !== undefined && root !== undefined && !result.isError
            && watched.has(exec.name) && path !== undefined) {
            const affected = await provider.query({ root, query: { operation: 'affected', node: path } }, exec.signal)
            if (affected.text.trim() === '') return decision
            const text = boundContext(`astria blast radius for ${path}:\n${affected.text}`, resolved.editContext.maxChars)
            return {
              ...decision,
              additionalContexts: [...decision.additionalContexts ?? [], createUserMessage({
                content: [{ type: 'text', text }],
                source: { kind: 'astria' },
              })],
            }
          }
        } catch (error) {
          // Attaching context is advisory; a failed blast-radius query never breaks the pipeline.
          scoped.logger.warn(`astria: attaching the edit blast-radius context failed: ${String(error)}`)
        }
        return decision
      })
    })
  }

  if (resolved.orientation.enabled) {
    // Broadcast durable events need no service dependency: the listener simply stays silent in
    // compositions without sessions, agents, or a graph.
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'compaction/end') return
      const root = session.header.cwd
      if (root === undefined) return
      void injectOrientation(ctx, provider, session.id, root, resolved.orientation.budgetTokens)
    })
  }
}

/** The `path` field of an edit tool's validated arguments, when it is a non-empty string. */
function pathOfEdit(arguments_: ToolExecution['arguments']): string | undefined {
  const path = (arguments_ as { path?: unknown } | undefined | null)?.path
  if (typeof path !== 'string' || path.trim() === '') return undefined
  return path
}

/** Bound one advisory context, keeping the omission marker inside the cap. */
function boundContext(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 60))}
… blast radius truncated (${maxChars}-character context cap).`
}

/**
 * Inject one token-budgeted repository map as the compacted session's next model-visible context.
 * Best effort throughout: no live agent, no graph, or an empty map simply skips orientation.
 * @param ctx - context used to resolve the session's live agent.
 * @param query - the registered provider's query face.
 * @param sessionId - the compacted session whose agent receives the map.
 * @param root - the session workspace root whose graph to map.
 * @param budgetTokens - the repo map's token budget.
 */
export async function injectOrientation(
  ctx: Context,
  query: Pick<CodeGraphService, 'query'>,
  sessionId: SessionId,
  root: string,
  budgetTokens: number,
): Promise<void> {
  const agent = ctx.get('agents')?.get(sessionId)
  if (agent === undefined) return
  try {
    const map = await query.query({ root, query: { operation: 'repoMap', budgetTokens } } satisfies CodeGraphQueryRequest)
    if (map.text.trim() === '') return
    try {
      agent.inject(createUserMessage({
        content: [{ type: 'text', text: `astria repository map after compaction:
${map.text}` }],
        source: { kind: 'astria' },
      }))
    } catch { /* the agent went away between resolution and injection */ }
  } catch { /* no graph or a failed query: orientation is best-effort and must stay silent */ }
}

/**
 * Start one owned background incremental refresh; the owning agent receives a durable notice when
 * the refreshed graph lands.
 * @param jobs - the active job registry; the job is fenced to the owning agent.
 * @param provider - the registered provider that runs `astria update`.
 * @param root - the workspace root whose graph to refresh.
 * @param agent - the agent whose edit triggered the refresh; owns and is notified about the job.
 */
export function startUpdateJob(
  jobs: JobRegistry,
  provider: Pick<AstriaCliProvider, 'refresh'>,
  root: string,
  agent: NonNullable<ToolExecution['agent']>,
): void {
  const cancel = new AbortController()
  jobs.start({
    kind: 'codegraph',
    label: `astria update ${root}`,
    owner: agent.id,
    run: () => refreshJobHooks(provider.refresh({ root, mode: 'update' }, cancel.signal), cancel, {
      completedDetail: 'graph updated',
      onCompleted: () => {
        try {
          // A disposed agent can no longer receive injections; the refresh still counts.
          agent.inject(createUserMessage({
            content: [{ type: 'text', text: `astria updated the code graph for ${root}; graph queries see current structure.` }],
            source: { kind: 'astria' },
          }))
        } catch { /* the agent went away while the refresh ran */ }
      },
    }),
  })
}

/**
 * Log the installed astria's own version line once at load. Best effort: the executable already
 * resolved, so a failed probe is a warning, never a gate on startup.
 * @param ctx - the plugin context, for the subprocess seam and the logger.
 * @param spec - the resolved provider spec (executable, env, grace).
 */
async function probeVersion(ctx: Context, spec: AstriaProviderSpec): Promise<void> {
  try {
    const handle = ctx.subprocess.spawn({
      argv: [spec.executable, '--version'],
      cwd: process.cwd(),
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 4_096 },
        stderr: { maxBytes: 4_096 },
      },
      graceMs: spec.killGraceMs,
      signal: AbortSignal.timeout(VERSION_PROBE_TIMEOUT_MS),
      env: spec.env,
    })
    const outcome = await handle.done
    const text = handle.collected.stdout?.readFrom(0).text.trim() ?? ''
    if (outcome.exitCode === 0 && text !== '') {
      ctx.logger.info(`astria provider: ${text}`)
    } else {
      ctx.logger.warn(`astria: the --version probe failed (exit ${outcome.exitCode === null ? `signal ${outcome.signal}` : `code ${outcome.exitCode}`})`)
    }
  } catch (error) {
    ctx.logger.warn(`astria: the --version probe failed: ${String(error)}`)
  }
}

/** Reject a nonpositive or non-integer config value at load, so misconfiguration fails loud. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`astria: ${name} must be a positive integer`)
  }
}

/** Reject a timer value Node would clamp instead of scheduling as configured. */
function assertTimer(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`astria: ${name} must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}
