/**
 * Code-graph seam vocabulary: the normalized request, provider, and result contracts. Types only —
 * the {@link CodeGraphError} taxonomy and the {@link CodeGraphProviderId} brand factory are runtime
 * and live in `index.ts`. The seam exposes no graph-store, process, or query-language escape hatch —
 * only the six repository-level operations and their bounded text results.
 * @module @deepseek-ai/dsh-codegraph/types
 */

import type { CodeGraphProviderId } from './brand.ts'

/**
 * The six repository-level queries the seam and model expose. A closed union: adding an operation is
 * a compile-enforced change across the seam, providers, and the tool. Symbol-level navigation is not
 * an operation here; `ctx.lsp` owns it.
 */
export type CodeGraphOperation = 'repoMap' | 'query' | 'explain' | 'path' | 'affected' | 'stats'

/**
 * One caller's normalized query, discriminated by `operation`. `question`, `node`, and
 * `source`/`target` are the operation's subject; `depth` limits traversal hops; `directed` follows
 * only caller-to-callee edges; `budgetTokens` caps the provider's rendered output in approximate
 * tokens (the consumer's result-character cap derives it — the model never passes it).
 */
export type CodeGraphQuery =
  | { readonly operation: 'repoMap'; readonly budgetTokens?: number }
  | {
    readonly operation: 'query'
    readonly question: string
    readonly depth?: number
    readonly directed?: boolean
    readonly budgetTokens?: number
  }
  | { readonly operation: 'explain'; readonly node: string }
  | { readonly operation: 'path'; readonly source: string; readonly target: string; readonly directed?: boolean }
  | { readonly operation: 'affected'; readonly node: string; readonly depth?: number }
  | { readonly operation: 'stats' }

/**
 * A caller's normalized request: the query plus the workspace root the graph was built for. The root
 * is caller-supplied and never defaulted; providers resolve it in their own execution world.
 */
export interface CodeGraphQueryRequest {
  /** The workspace root whose graph to query. */
  readonly root: string
  /** Which repository-level query to run. */
  readonly query: CodeGraphQuery
}

/**
 * The closed result union. v1 normalizes every operation to bounded text: `text` is the provider's
 * complete report (markdown or plaintext) and `truncated` is true when the provider's own output
 * bound kept only its tail. Consumers `switch` on `kind` to exhaustiveness so a new arm breaks
 * compilation until handled.
 */
export type CodeGraphResult = {
  readonly kind: 'text'
  readonly text: string
  readonly truncated: boolean
}

/**
 * A code-graph backend registered on `ctx.codeGraph`. The registry holds at most one provider per
 * scope; a second registration fails with `CODEGRAPH_CONFLICT`, so selection never depends on
 * registration order. Providers implement every operation; refinement fields they cannot honor are
 * ignored, never fatal.
 */
export interface CodeGraphProvider {
  /** Stable provider identity, validated by the registry at registration. */
  readonly id: CodeGraphProviderId
  /**
   * Run one query.
   * @param request - the normalized query plus workspace root.
   * @param signal - optional cancellation; the provider stops its own work when it aborts.
   * @returns the normalized, closed-union result.
   */
  query(request: CodeGraphQueryRequest, signal?: AbortSignal): Promise<CodeGraphResult>
}

/**
 * The code-graph capability seam (`ctx.codeGraph`). Owns the sole-provider slot and normalized
 * query execution; exposes exactly the six operations and no store or process escape hatch.
 */
export interface CodeGraphService {
  /**
   * Register the scope's sole provider. An empty id or an occupied slot throws `CodeGraphError`;
   * the returned disposer releases the slot. Disposed with the calling fiber.
   * @param provider - the backend to register.
   * @returns a synchronous disposer releasing the slot.
   */
  registerProvider(provider: CodeGraphProvider): () => void
  /**
   * Run one query through the registered provider. No provider throws `CodeGraphError`
   * `CODEGRAPH_UNAVAILABLE`.
   * @param request - the normalized query plus workspace root.
   * @param signal - optional cancellation forwarded to the provider.
   * @returns the normalized, closed-union result.
   */
  query(request: CodeGraphQueryRequest, signal?: AbortSignal): Promise<CodeGraphResult>
}
