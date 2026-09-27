/**
 * The one-shot astria CLI provider: answers each seam query by spawning the resolved astria
 * executable once through the injected spawner, collecting bounded stdout/stderr, and classifying
 * the exit. Cancellation fuses the caller's signal with the provider lifetime so disposal terminates
 * in-flight children through the subprocess seam's managed range.
 * @module @deepseek-ai/dsh-astria/provider
 */

import { CodeGraphError, CodeGraphProviderId } from '@deepseek-ai/dsh-codegraph'
import type {
  CodeGraphProvider,
  CodeGraphQueryRequest,
  CodeGraphRefreshRequest,
  CodeGraphResult,
} from '@deepseek-ai/dsh-codegraph'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { buildAstriaArgs, buildAstriaRefreshArgs } from './args.ts'
import { parseAstriaStatus, renderAstriaStatus } from './status.ts'

/** Spawns one managed child from a fully-specified request (injected for testability). */
export type AstriaSpawner = (spec: SubprocessSpawnSpec) => SubprocessHandle

/** The provider's resolved configuration: one executable and its host bounds. */
export interface AstriaProviderSpec {
  /** Canonical executable path resolved in this provider's execution world at load. */
  readonly executable: string
  /** Extra global arguments inserted between the executable and the operation subcommand. */
  readonly args: readonly string[]
  /** Explicit environment entries merged onto the spawner's scrubbed parent base. */
  readonly env: Readonly<Record<string, string>>
  /** In-memory cap for collected stdout (bytes); overflow keeps the tail. */
  readonly maxOutputBytes: number
  /** In-memory cap for collected stderr (bytes); overflow keeps the tail. */
  readonly maxStderrBytes: number
  /** Termination grace forwarded to the subprocess seam's managed range (ms). */
  readonly killGraceMs: number
}

/**
 * A `ctx.codeGraph` provider backed by the astria CLI. Stateless between queries: every operation
 * is one complete child-process run, so a crashed or absent graph database surfaces as that run's
 * exit facts rather than pooled-process state.
 */
export class AstriaCliProvider implements CodeGraphProvider {
  readonly id: CodeGraphProviderId
  private readonly lifetime = new AbortController()
  private readonly inFlight = new Set<Promise<unknown>>()
  private disposed = false

  constructor(private readonly spec: AstriaProviderSpec, private readonly spawn: AstriaSpawner) {
    this.id = CodeGraphProviderId('astria')
  }

  /** Read the disposed flag through a method so a `query()` await cannot narrow it to a literal. */
  private isDisposed(): boolean {
    return this.disposed
  }

  /** Reject work that cannot start or continue a provider-owned child. */
  private assertActive(signal?: AbortSignal): void {
    if (this.isDisposed()) throw new CodeGraphError('astria provider is disposed', 'CODEGRAPH_DISPOSED')
    signal?.throwIfAborted()
  }

  /** Fuse caller cancellation with provider disposal for every spawn and await. */
  private querySignal(signal?: AbortSignal): AbortSignal {
    return signal === undefined
      ? this.lifetime.signal
      : AbortSignal.any([signal, this.lifetime.signal])
  }

  async query(request: CodeGraphQueryRequest, signal?: AbortSignal): Promise<CodeGraphResult> {
    // Honor an already-aborted signal before spawning so a canceled request never starts a child.
    this.assertActive(signal)
    const fused = this.querySignal(signal)
    const run = this.settle(
      this.spawn(this.spawnSpec(buildAstriaArgs(request), request.root, fused)),
      request.query.operation,
      fused,
    )
    // `status` answers with astria's JSON envelope; normalize it so consumers get stable freshness
    // facts and a missing graph surfaces as the structured no-graph error.
    if (request.query.operation !== 'status') return this.track(run)
    return this.track(run.then(result => this.normalizeStatus(result)))
  }

  /**
   * Normalize one settled `status` run: a parsed envelope becomes the stable rendered report (the
   * truncation fact survives), a `missing` graph becomes `CODEGRAPH_NO_GRAPH` so consumers react by
   * building, and anything unparsed (a future CLI's changed output, a truncated envelope) passes
   * through as the raw text.
   */
  private normalizeStatus(result: CodeGraphResult): CodeGraphResult {
    const facts = parseAstriaStatus(result.text)
    if (facts === undefined) return result
    if (facts.status === 'missing') {
      throw new CodeGraphError('astria status reports no graph found for the workspace', 'CODEGRAPH_NO_GRAPH')
    }
    return { ...result, text: renderAstriaStatus(facts) }
  }

  async refresh(request: CodeGraphRefreshRequest, signal?: AbortSignal): Promise<CodeGraphResult> {
    this.assertActive(signal)
    const fused = this.querySignal(signal)
    return this.track(this.settle(
      this.spawn(this.spawnSpec(buildAstriaRefreshArgs(request), request.root, fused)),
      `graph ${request.mode}`,
      fused,
    ))
  }

  /** One fully-specified spawn request for an astria child with bounded collection. */
  private spawnSpec(argv: readonly string[], root: string, fused: AbortSignal): SubprocessSpawnSpec {
    return {
      argv: [this.spec.executable, ...this.spec.args, ...argv],
      cwd: root,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: this.spec.maxOutputBytes },
        stderr: { maxBytes: this.spec.maxStderrBytes },
      },
      graceMs: this.spec.killGraceMs,
      signal: fused,
      env: this.spec.env,
    }
  }

  /** Classify one settled child into the result union or a structured failure. */
  private async settle(handle: SubprocessHandle, label: string, fused: AbortSignal): Promise<CodeGraphResult> {
    const outcome = await handle.done
    // A termination our fused signal requested resolves `done` with signal exit facts; surface the
    // caller's or disposal's abort reason instead of misreading it as an astria failure.
    fused.throwIfAborted()
    if (outcome.exitCode !== 0) {
      const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
      // The missing-graph failure gets its own code so consumers can react by building; the match
      // is on astria's stable "No graph found" line, documented in the README's limitations.
      if (/No graph found/i.test(stderr)) {
        throw new CodeGraphError(stderr, 'CODEGRAPH_NO_GRAPH')
      }
      const detail = stderr === '' ? '' : `: ${stderr}`
      const exit = outcome.exitCode === null ? `signal ${outcome.signal}` : `exit code ${outcome.exitCode}`
      throw new CodeGraphError(`astria ${label} failed with ${exit}${detail}`, 'CODEGRAPH_EXIT')
    }
    const stdout = handle.collected.stdout?.readFrom(0)
    return {
      kind: 'text' as const,
      text: stdout?.text ?? '',
      truncated: stdout?.lossy === true,
    }
  }

  /** Keep the provider's disposal quiescent on every in-flight child. */
  private track<T>(run: Promise<T>): Promise<T> {
    this.inFlight.add(run)
    void run.catch(() => undefined).then(() => this.inFlight.delete(run))
    return run
  }

  /** Block further queries, terminate in-flight children through their fused signals, and wait. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.lifetime.abort(new CodeGraphError('astria provider is disposed', 'CODEGRAPH_DISPOSED'))
    await Promise.allSettled([...this.inFlight])
  }
}
