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
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { AstriaCliProvider } from './provider.ts'
import type { AstriaProviderSpec, AstriaSpawner } from './provider.ts'

export { buildAstriaArgs } from './args.ts'
export { AstriaCliProvider } from './provider.ts'
export type { AstriaProviderSpec, AstriaSpawner } from './provider.ts'

/** Cordis plugin name for loader diagnostics. */
export const name = 'astria'

/** Services required by this plugin. */
export const inject = ['subprocess', 'codeGraph']

const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000
const DEFAULT_MAX_STDERR_BYTES = 100_000
const DEFAULT_KILL_GRACE_MS = 2_000

/** Plugin configuration: the astria executable and its host bounds. */
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
}

export const Config: z<Config> = z.object({
  command: z.string().default('astria'),
  args: z.array(String).default([]),
  env: z.dict(String).default({}),
  maxOutputBytes: z.number().default(DEFAULT_MAX_OUTPUT_BYTES),
  maxStderrBytes: z.number().default(DEFAULT_MAX_STDERR_BYTES),
  killGraceMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_KILL_GRACE_MS),
})

/** One plugin config after schemastery fills every default. */
type ResolvedConfig = Required<Config>

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
