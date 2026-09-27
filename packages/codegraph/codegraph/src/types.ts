/**
 * Code-graph seam vocabulary: the normalized request, provider, and result contracts. Types only —
 * the {@link CodeGraphError} taxonomy and the {@link CodeGraphProviderId} brand factory are runtime
 * and live in `index.ts`. The seam exposes no graph-store, process, or query-language escape hatch —
 * only the ten repository-level operations, their bounded text results, and the export artifact.
 * @module @deepseek-ai/dsh-codegraph/types
 */

import type { CodeGraphProviderId } from './brand.ts'

/**
 * The ten repository-level operations the seam and model expose. A closed union: adding an
 * operation is a compile-enforced change across the seam, providers, and the tool. Symbol-level
 * navigation is not an operation here; `ctx.lsp` owns it. Nine operations answer with bounded text;
 * `export` writes a viewable graph artifact instead of answering a question. `hubs`, `communities`,
 * and `status` need astria ≥ 1.0.6 on a one-shot transport; `status` reports graph freshness, build
 * time, astria version, and extraction-rules versions instead of graph content.
 */
export type CodeGraphOperation =
  | 'repoMap'
  | 'query'
  | 'explain'
  | 'path'
  | 'affected'
  | 'stats'
  | 'export'
  | 'hubs'
  | 'communities'
  | 'status'

/** The viewable artifact formats the `export` operation writes: an interactive page or a static image. */
export type CodeGraphExportFormat = 'html' | 'svg'

/**
 * One caller's normalized query, discriminated by `operation`. `question`, `node`, and
 * `source`/`target` are the operation's subject; `depth` limits traversal hops; `directed` follows
 * only caller-to-callee edges; `cursor` continues a truncated `query` from the provider-reported
 * continuation token; `budgetTokens` caps the provider's rendered output in approximate tokens
 * (the consumer's result-character cap derives it — the model never passes it). `export` carries
 * its `format` and the destination `out` path — callers own placement, the provider never defaults
 * a destination. `hubs`, `communities`, and `status` take no subject: they answer graph-level
 * structure (hub nodes, communities, freshness, build time, and tool versions).
 */
export type CodeGraphQuery =
  | { readonly operation: 'repoMap'; readonly budgetTokens?: number }
  | {
    readonly operation: 'query'
    readonly question: string
    readonly depth?: number
    readonly directed?: boolean
    readonly cursor?: number
    readonly budgetTokens?: number
  }
  | { readonly operation: 'explain'; readonly node: string }
  | { readonly operation: 'path'; readonly source: string; readonly target: string; readonly directed?: boolean }
  | { readonly operation: 'affected'; readonly node: string; readonly depth?: number }
  | { readonly operation: 'stats' }
  | { readonly operation: 'export'; readonly format: CodeGraphExportFormat; readonly out: string }
  | { readonly operation: 'hubs' }
  | { readonly operation: 'communities' }
  | { readonly operation: 'status' }

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

/** One graph refresh mode: the full pipeline (`build`) or an incremental AST-only pass (`update`). */
export type CodeGraphRefreshMode = 'build' | 'update'

/**
 * A caller's normalized refresh request: rebuild or incrementally update the workspace graph at
 * `root`. Refresh runs the provider's build pipeline; it is not a query and never reads the graph.
 */
export interface CodeGraphRefreshRequest {
  /** The workspace root whose graph to rebuild. */
  readonly root: string
  /** Whether to run the full pipeline or the incremental pass. */
  readonly mode: CodeGraphRefreshMode
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
  /**
   * Rebuild or incrementally update the workspace graph. Long-running: callers own deadlines and
   * background-job placement; the provider honors cancellation.
   * @param request - the refresh request (root plus mode).
   * @param signal - optional cancellation; the provider stops its build when it aborts.
   * @returns the build run's bounded text report.
   */
  refresh(request: CodeGraphRefreshRequest, signal?: AbortSignal): Promise<CodeGraphResult>
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
  /**
   * Rebuild or incrementally update the workspace graph through the registered provider. No
   * provider throws `CodeGraphError` `CODEGRAPH_UNAVAILABLE`. Long-running: callers own deadlines
   * and background-job placement.
   * @param request - the refresh request (root plus mode).
   * @param signal - optional cancellation forwarded to the provider.
   * @returns the build run's bounded text report.
   */
  refresh(request: CodeGraphRefreshRequest, signal?: AbortSignal): Promise<CodeGraphResult>
}
