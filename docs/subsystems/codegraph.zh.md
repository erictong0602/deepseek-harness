# 代码图导航

[English](codegraph.md) | 中文

代码图 seam — 一个在单一 `ctx.codeGraph` 服务上暴露仓库级图问题的[能力 seam](../glossary.zh.md#capability-seam)，跨包拆分：服务定义（[dsh-codegraph](../../packages/codegraph/codegraph)，`ctx.codeGraph` 与单提供方槽位）、服务提供方（[dsh-astria](../../packages/codegraph/astria)，一次性 astria CLI 宿主）与消费者（[dsh-tool-codegraph](../../packages/codegraph/tool-codegraph)，`code_graph` 工具 schema）。代码图是**一个可选能力**，不属于 agent-loop 主干 — 因此其词汇表放在这里而不是 [core.md](core.zh.md)。更换提供方不会改变模型提问图问题的方式。符号级精确属于 [lsp.md](lsp.zh.md)；本 seam 回答结构。

来源：[`packages/codegraph/codegraph/src/types.ts`](../../packages/codegraph/codegraph/src/types.ts)

## 操作

seam 与模型恰好暴露六个仓库级查询；联合类型是封闭的，因此新增操作是 seam、提供方与工具的编译期强制变更。`budgetTokens` 由生产者拥有（工具从其结果上限推导）；模型从不传递它。

```ts type-equiv
/**
 * The six repository-level queries the seam and model expose. A closed union: adding an operation is
 * a compile-enforced change across the seam, providers, and the tool. Symbol-level navigation is not
 * an operation here; `ctx.lsp` owns it.
 */
type CodeGraphOperation = 'repoMap' | 'query' | 'explain' | 'path' | 'affected' | 'stats'
```

## 请求与结果

每个请求都携带待查询工作区的根；由调用方提供且永不被默认。细化字段（`depth`、`directed`、`budgetTokens`）是可选的；无法满足某一字段的提供方应忽略它而不是失败。

```ts type-equiv
/**
 * One caller's normalized query, discriminated by `operation`. `question`, `node`, and
 * `source`/`target` are the operation's subject; `depth` limits traversal hops; `directed` follows
 * only caller-to-callee edges; `budgetTokens` caps the provider's rendered output in approximate
 * tokens (the consumer's result-character cap derives it — the model never passes it).
 */
type CodeGraphQuery =
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

## 刷新

刷新在查询路径之外重建工作区图：`build` 运行提供方的完整流水线，`update` 运行增量 AST-only 重建。刷新由调用方调度 — 模型可见工具通过 `ctx.jobs` 将其移出回合，编辑后监听器自行调度 — 并返回同样的有界文本结果联合。

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

## 提供方与服务

每个作用域一个提供方：第二个注册以 `CODEGRAPH_CONFLICT` 失败，因此选择永不依赖注册顺序，注册纤程的释放会归还槽位。

`CodeGraphProviderId` 是 seam 的品牌化 id（来自 [dsh-brand](../../packages/util/brand) 的 `Branded<'CodeGraphProviderId'>`）；`CodeGraphError` 继承 `HarnessError`，带有 `CODEGRAPH_INVALID_PROVIDER`、`CODEGRAPH_CONFLICT`、`CODEGRAPH_UNAVAILABLE`、`CODEGRAPH_DISPOSED`、`CODEGRAPH_EXIT` 与 `CODEGRAPH_WORKSPACE_REQUIRED` 等稳定代码，调用方据此路由而不是解析 `message`。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
