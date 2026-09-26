/**
 * Service Definition for the code-graph capability seam (`ctx.codeGraph`): a sole-provider registry
 * over normalized repository-map / natural-language-query / symbol-explain / shortest-path /
 * impact / stats queries with bounded text results.
 *
 * One provider per scope reserves the slot atomically: {@link CodeGraph.registerProvider} validates
 * the id before mutating, a conflicting registration publishes nothing, and the disposer releases
 * the slot with the calling fiber. The seam exposes exactly the six operations and no graph-store or
 * process escape hatch.
 * @module @deepseek-ai/dsh-codegraph
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type {
  CodeGraphOperation,
  CodeGraphProvider,
  CodeGraphQueryRequest,
  CodeGraphResult,
  CodeGraphService,
} from './types.ts'

export { CodeGraphProviderId } from './brand.ts'
export type {
  CodeGraphOperation,
  CodeGraphProvider,
  CodeGraphQuery,
  CodeGraphQueryRequest,
  CodeGraphResult,
  CodeGraphService,
} from './types.ts'

/**
 * The six operations as a runtime tuple, kept beside the closed {@link CodeGraphOperation} union so
 * schema enums and validators derive from one list. A new operation changes both together.
 */
export const CODEGRAPH_OPERATIONS: readonly CodeGraphOperation[] = ['repoMap', 'query', 'explain', 'path', 'affected', 'stats']

declare module '@deepseek-ai/cordis' {
  interface Context {
    codeGraph: CodeGraphService
  }
}

/**
 * Structured code-graph failure. Extends {@link HarnessError} with a stable `code`
 * (`CODEGRAPH_INVALID_PROVIDER`, `CODEGRAPH_CONFLICT`, `CODEGRAPH_UNAVAILABLE`,
 * `CODEGRAPH_DISPOSED`, `CODEGRAPH_EXIT`, `CODEGRAPH_WORKSPACE_REQUIRED`) that callers route on
 * instead of parsing `message`. The seam owns the first three; providers and consumers extend the
 * taxonomy through this same class.
 */
export class CodeGraphError extends HarnessError {}

/**
 * `ctx.codeGraph`. Holds the sole provider slot; registration and release are one lifecycle
 * controller so a query never reaches an unregistered provider.
 */
export class CodeGraph extends Service implements CodeGraphService {
  private provider: CodeGraphProvider | undefined

  constructor(ctx: Context) {
    super(ctx, 'codeGraph')
  }

  registerProvider(provider: CodeGraphProvider): () => void {
    // Validate BEFORE any mutation: an invalid registration must publish nothing (fail-loud).
    if (provider.id.trim() === '') {
      throw new CodeGraphError('a code-graph provider id must be a non-empty string', 'CODEGRAPH_INVALID_PROVIDER')
    }
    if (this.provider !== undefined) {
      throw new CodeGraphError('a code-graph provider is already registered in this scope', 'CODEGRAPH_CONFLICT')
    }

    const dispose = this.ctx.effect(function* (this: CodeGraph) {
      this.provider = provider
      yield () => {
        // Safe unconditionally: a successor can register only after this disposer released the slot.
        this.provider = undefined
      }
    }.bind(this), 'codeGraph.registerProvider()')
    // ctx.effect's disposer returns Promise<void>; our disposer API is synchronous
    // fire-and-forget — discard the (always-resolved) promise.
    return () => void dispose()
  }

  async query(request: CodeGraphQueryRequest, signal?: AbortSignal): Promise<CodeGraphResult> {
    const provider = this.provider
    if (provider === undefined) {
      throw new CodeGraphError('no code-graph provider is registered in this scope', 'CODEGRAPH_UNAVAILABLE')
    }
    return provider.query(request, signal)
  }
}

export default CodeGraph
