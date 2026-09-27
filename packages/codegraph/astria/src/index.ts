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
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { AstriaCliProvider } from './provider.ts'
import type { AstriaProviderSpec, AstriaSpawner } from './provider.ts'

export { buildAstriaArgs, buildAstriaRefreshArgs } from './args.ts'
export { AstriaCliProvider } from './provider.ts'
export type { AstriaProviderSpec, AstriaSpawner } from './provider.ts'

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

/** File-mutating tool names that trigger a debounced incremental refresh. */
export const DEFAULT_AUTO_UPDATE_TOOLS: readonly string[] = ['write', 'edit', 'str_replace_editor']

/** Debounced post-edit graph refresh; enabled deployments only. */
export interface AutoUpdateConfig {
  /** Listen for file-mutating tool results and refresh the graph. Default false. */
  enabled?: boolean
  /** Quiet window after the last edit before the refresh job starts (ms). Default 3000. */
  debounceMs?: number
  /** Tool names that count as edits. Default write, edit, str_replace_editor. */
  tools?: string[]
}

/** Plugin configuration: the astria executable, its host bounds, and post-edit refresh. */
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
  /** Debounced incremental refresh after file-mutating tools. Default disabled. */
  autoUpdate?: AutoUpdateConfig
}

const AutoUpdateConfig: z<AutoUpdateConfig> = z.object({
  enabled: z.boolean().default(false),
  debounceMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_AUTO_UPDATE_DEBOUNCE_MS),
  tools: z.array(String).default([...DEFAULT_AUTO_UPDATE_TOOLS]),
})

export const Config: z<Config> = z.object({
  command: z.string().default('astria'),
  args: z.array(String).default([]),
  env: z.dict(String).default({}),
  maxOutputBytes: z.number().default(DEFAULT_MAX_OUTPUT_BYTES),
  maxStderrBytes: z.number().default(DEFAULT_MAX_STDERR_BYTES),
  killGraceMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_KILL_GRACE_MS),
  autoUpdate: AutoUpdateConfig.default({
    enabled: false,
    debounceMs: DEFAULT_AUTO_UPDATE_DEBOUNCE_MS,
    tools: [...DEFAULT_AUTO_UPDATE_TOOLS],
  }),
})

/** One plugin config after schemastery fills every default. */
type ResolvedConfig = Required<Omit<Config, 'autoUpdate'>> & { autoUpdate: Required<AutoUpdateConfig> }

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

  const setupAbort = new AbortController()
  const stopSetupCancellation = ctx.on('internal/plugin', (fiber) => {
    // An async plugin callback must observe its own disposal before Cordis can
    // run effect cleanup, because unload otherwise waits for this callback.
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
    maxOutputBytes: resolved.maxOutputBytes,
    maxStderrBytes: resolved.maxStderrBytes,
    killGraceMs: resolved.killGraceMs,
  }
  const spawner: AstriaSpawner = spawnSpec => ctx.subprocess.spawn(spawnSpec)
  const provider = new AstriaCliProvider(spec, spawner)

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
  provider: AstriaCliProvider,
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
