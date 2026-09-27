---
description: "The code-graph Service Definition (ctx.codeGraph): a sole-provider registry over six normalized repository-level operations with bounded text results and the CodeGraphError taxonomy, for users and maintainers composing code-graph navigation."
kind: "package-reference"
---

# @deepseek-ai/dsh-codegraph

English | [中文](README.zh.md)

## Summary

`dsh-codegraph` defines the code-graph capability seam: one scope holds at most one provider, queries are six normalized read-only operations (`repoMap`, `query`, `explain`, `path`, `affected`, `stats`), and every result is bounded text with an explicit truncation fact. Use it when composing a code-graph backend or a consumer; use [`dsh-astria`](../astria/README.md) for the reference provider and [`dsh-tool-codegraph`](../tool-codegraph/README.md) for the model-facing tool. Symbol-level navigation belongs to `ctx.lsp`, not this seam.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package when a provider or consumer needs `ctx.codeGraph`. A provider reserves the scope's sole slot; a second registration fails with `CODEGRAPH_CONFLICT`, so selection never depends on registration order, and disposal of the registering fiber releases the slot. A query with no provider fails with `CODEGRAPH_UNAVAILABLE`.

```ts
import type { Context } from '@deepseek-ai/cordis'
import { CodeGraphProviderId } from '@deepseek-ai/dsh-codegraph'
import type { CodeGraphQueryRequest, CodeGraphRefreshRequest, CodeGraphResult } from '@deepseek-ai/dsh-codegraph'
import '@deepseek-ai/dsh-codegraph'

export const name = 'my-codegraph-provider'
export const inject = ['codeGraph']

export function apply(ctx: Context): void {
  ctx.codeGraph.registerProvider({
    id: CodeGraphProviderId('my-backend'),
    async query(request: CodeGraphQueryRequest): Promise<CodeGraphResult> {
      // answer request.query (one of the six operations) for request.root
      return { kind: 'text', text: 'report', truncated: false }
    },
    async refresh(request: CodeGraphRefreshRequest): Promise<CodeGraphResult> {
      // rebuild (mode 'build') or incrementally update (mode 'update') request.root
      return { kind: 'text', text: 'rebuilt', truncated: false }
    },
  })
}
```

Every request carries the workspace `root` whose graph to query; providers resolve it in their own execution world. Refinement fields (`depth`, `directed`, `budgetTokens`) are optional; a provider that cannot honor one ignores it rather than failing.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

- **Sole-provider slot.** One provider per scope: a second registration throws `CODEGRAPH_CONFLICT` before mutating anything, and the slot's disposer clears it with the registering fiber. This mirrors the single-provider seams (session titles) rather than `ctx.lsp`'s extension-keyed table, because a workspace has one graph, not one per file type.
- **Closed operation union.** `CodeGraphQuery` discriminates six operations, and `CODEGRAPH_OPERATIONS` is their runtime tuple kept in the same package so schema enums and validators derive from one list; adding an operation is a compile-enforced change across the seam, providers, and the tool. The request is a `{ root, query }` wrapper so the root is never defaulted.
- **One-arm result union.** `CodeGraphResult` is `{ kind: 'text', text, truncated }`; `truncated` reports the provider's own output bound, distinct from any consumer-side rendering cap. A second arm (for example structured locations) would switch consumers by `kind`.
- **Refresh is caller-scheduled.** `refresh` runs the provider's build pipeline and never decides its own placement: the model-facing tool takes it off the turn through `ctx.jobs`, and post-edit listeners schedule their own.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-astria`](../astria/README.md) — the CLI provider that answers these queries.
- [`dsh-tool-codegraph`](../tool-codegraph/README.md) — the model-facing consumer.
- [codegraph group map](../README.md) — the three-package family and its related documentation.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-codegraph`, which surfaces a registered provider's normalized results while this definition contributes no prompt or schema itself.

#### KV Cache effect

No direct invalidation; `dsh-tool-codegraph` owns request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe what the seam does not decide. They are current package constraints, not a task backlog.

- **Text-only results** — v1 normalizes every operation and refresh to bounded text; structured results (locations, node records) would extend the result union and their consumers together.
- **No freshness policy** — `refresh` rebuilds on demand; deciding when a graph is stale (watching, mtime checks) stays with consumers, and a stale graph still answers queries.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
