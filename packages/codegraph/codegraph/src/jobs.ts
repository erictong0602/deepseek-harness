/**
 * The shared refresh-to-job adaptation: one place turns a `refresh` promise and its cancellation
 * controller into the `ctx.jobs` hooks vocabulary (`completed` on settlement, `killed` when the
 * cancellation signal fired, `failed` with the provider's message otherwise), so the model-facing
 * tool and post-edit listeners schedule identical background refreshes.
 * @module @deepseek-ai/dsh-codegraph/jobs
 */

import type { JobHooks, JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { CodeGraphResult } from './types.ts'

/** Options for one {@link refreshJobHooks} adaptation. */
export interface RefreshJobOptions {
  /** The completed outcome's terminal detail line. */
  readonly completedDetail: string
  /** Runs after a successful refresh, before the outcome settles; used for completion notices. */
  readonly onCompleted?: () => void
}

/**
 * Adapt one running refresh to the job hooks vocabulary. The returned `cancel` aborts the given
 * controller; a refresh that fails after its own signal aborted settles `killed`, and any other
 * failure settles `failed` carrying the error's message.
 * @param refresh - the in-flight refresh promise from the seam.
 * @param cancel - the controller whose signal the refresh observes; `cancel()` aborts it.
 * @param options - the completed detail line and an optional completion callback.
 * @returns the hooks a `ctx.jobs` producer returns from its starter.
 */
export function refreshJobHooks(refresh: Promise<CodeGraphResult>, cancel: AbortController, options: RefreshJobOptions): JobHooks {
  const done = refresh.then(
    (): JobOutcome => {
      options.onCompleted?.()
      return { status: 'completed', detail: options.completedDetail }
    },
    (error: unknown): JobOutcome =>
      cancel.signal.aborted
        ? { status: 'killed', detail: 'cancelled' }
        : { status: 'failed', detail: error instanceof Error ? error.message : String(error) },
  )
  return {
    done,
    cancel: (reason?: string) => {
      cancel.abort(new Error(reason === undefined || reason === '' ? 'cancelled' : reason))
    },
  }
}
