# Code-graph navigation

English | [中文](codegraph.zh.md)

The code-graph seam — a [capability seam](../glossary.md#capability-seam) exposing repository-level graph questions on one `ctx.codeGraph` service, split across packages: Service Definition ([dsh-codegraph](../../packages/codegraph/codegraph), `ctx.codeGraph` + the sole-provider slot), a Service Provider ([dsh-astria](../../packages/codegraph/astria), a one-shot astria CLI host), and Consumer ([dsh-tool-codegraph](../../packages/codegraph/tool-codegraph), the `code_graph` tool schema). The graph is **one optional capability**, not part of the agent-loop spine — so its vocabulary lives here, not in [core.md](core.md). A provider swap does not change how the model asks graph questions. Symbol-level precision belongs to [lsp.md](lsp.md); this seam answers structure.

Source: [`packages/codegraph/codegraph/src/types.ts`](../../packages/codegraph/codegraph/src/types.ts)

## Operations

The seam and model expose exactly ten repository-level operations; the union is closed, so adding one is a compile-enforced change across the seam, providers, and the tool. Nine answer with bounded text; `export` writes a viewable graph artifact at a caller-owned destination. `budgetTokens` is producer-owned (the tool derives it from its result cap); the model never passes it.

```ts type-equiv
/**
 * The ten repository-level operations the seam and model expose. A closed union: adding an
 * operation is a compile-enforced change across the seam, providers, and the tool. Symbol-level
 * navigation is not an operation here; `ctx.lsp` owns it. Nine operations answer with bounded text;
 * `export` writes a viewable graph artifact instead of answering a question. `hubs`, `communities`,
 * and `status` need astria ≥ 1.0.6 on a one-shot transport; `status` reports graph freshness, build
 * time, astria version, and extraction-rules versions instead of graph content.
 */
type CodeGraphOperation =
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
```

## Request and result

Every request carries the workspace root whose graph to query; it is caller-supplied and never defaulted. Refinement fields (`depth`, `directed`, `budgetTokens`) are optional; a provider that cannot honor one ignores it rather than failing.

```ts type-equiv
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
type CodeGraphQuery =
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
```

```ts type-equiv
/**
 * The closed result union. v1 normalizes every operation to bounded text: `text` is the provider's
 * complete report (markdown or plaintext) and `truncated` is true when the provider's own output
 * bound kept only its tail. Consumers `switch` on `kind` to exhaustiveness so a new arm breaks
 * compilation until handled.
 */
type CodeGraphResult = {
  readonly kind: 'text'
  readonly text: string
  readonly truncated: boolean
}
```

## Refresh

Refresh rebuilds the workspace graph outside the query path: `build` runs the provider's full pipeline, `update` the incremental AST-only pass. Refresh is caller-scheduled — the model-facing tool takes it off the turn through `ctx.jobs`, and post-edit listeners schedule their own — and returns the same bounded text result union.

```ts type-equiv
/**
 * A caller's normalized refresh request: rebuild or incrementally update the workspace graph at
 * `root`. Refresh runs the provider's build pipeline; it is not a query and never reads the graph.
 */
interface CodeGraphRefreshRequest {
  /** The workspace root whose graph to rebuild. */
  readonly root: string
  /** Whether to run the full pipeline or the incremental pass. */
  readonly mode: CodeGraphRefreshMode
}
```

## Provider and service

One provider per scope: a second registration fails with `CODEGRAPH_CONFLICT`, so selection never depends on registration order, and disposal of the registering fiber releases the slot.

`CodeGraphProviderId` is the seam's branded id (`Branded<'CodeGraphProviderId'>` from [dsh-brand](../../packages/util/brand)); `CodeGraphError` extends `HarnessError` with stable codes such as `CODEGRAPH_INVALID_PROVIDER`, `CODEGRAPH_CONFLICT`, `CODEGRAPH_UNAVAILABLE`, `CODEGRAPH_DISPOSED`, `CODEGRAPH_EXIT`, and `CODEGRAPH_WORKSPACE_REQUIRED`, which callers route on instead of parsing `message`.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcodegraph--codegraphservice"></a>

### `ctx.codeGraph` — `CodeGraphService`

The code-graph capability seam (`ctx.codeGraph`). Owns the sole-provider slot and normalized query execution; exposes exactly the six operations and no store or process escape hatch.

```ts cordis-catalog
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
```

Source: [`packages/codegraph/codegraph/src/types.ts`](../../packages/codegraph/codegraph/src/types.ts)
<!-- END GENERATED cordis-surface -->
