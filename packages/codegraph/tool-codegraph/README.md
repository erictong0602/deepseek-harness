---
description: "The model-facing code_graph tool: six read-only repository-level graph operations with per-operation argument validation, derived token budgets, and complete-result character capping, for users and maintainers composing model code-graph questions."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-codegraph

English | [中文](README.zh.md)

## Summary

`dsh-tool-codegraph` lets a model ask repository-level questions and rebuild the graph through one tool: six query operations (overview repo map, natural-language query, symbol explanation, shortest path, blast radius, graph statistics) and two refresh operations (`build`, `update`). Refreshes run as `ctx.jobs` background jobs when a registry and an owning agent exist, returning the job id at once, and foreground otherwise. Arguments are validated per operation, results are capped in complete rendered characters, and the provider's token budget derives from that cap. The package requires a registered `ctx.codeGraph` provider and a session workspace root; choose it for repository-level structure, not ordinary navigation.

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

An agent uses `code_graph` when a question is about structure — "what does changing X affect", "how do these two modules connect" — rather than about one symbol's definition. The tool's prompt guidance positions it against `search`/`read` and `lsp`.

### The tool

`code_graph` takes `operation` (`repoMap`, `query`, `explain`, `path`, `affected`, `stats`, `build`, or `update`) plus the operation's subject: `question` for `query`; `node` for `explain` and `affected`; `source` and `target` for `path`. `depth` (positive integer), `directed`, and `cursor` (the continuation token a truncated query shows) refine traversal; `build` and `update` take no subject. A query against a missing graph does not dead-end: with a job registry and refresh enabled, the call starts a background build and says when to retry. Provider choice, token budgets, background placement, the executable, and timeouts stay outside model input.

### What the model gets back

Every query returns the provider's complete report text plus a `truncated` fact. The rendered result is capped in complete characters with an in-cap truncation marker; a provider-side truncation gets its own marker. An empty report renders a distinct `No output.` line, and a provider failure arrives as the error text the model can read and route on — a missing graph says how to build it. A background refresh returns `started background job <id>` immediately; the job tools read its output and completion.

### Configuration

| Key | Default | Meaning |
|---|---|---|
| `maxResultChars` | `16000` | Largest complete rendered result, including truncation metadata; also derives the provider's token budget |
| `timeoutMs` | `60000` | Tool-call timeout budget enforced by `dsh-tool-call-timeout-policy`; covers one complete foreground provider child run and is not model-configurable |
| `allowRefresh` | `true` | Expose the `build` and `update` operations; a disabled call fails loudly instead of silently |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-codegraph) is the exhaustive source for every accepted field.

### Failures and recovery

The tool requires a session workspace root (`header.cwd`) with no fallback; absence fails with `CODEGRAPH_WORKSPACE_REQUIRED` before any query. No registered provider fails with `CODEGRAPH_UNAVAILABLE`, and a failed astria run arrives as `CODEGRAPH_EXIT` carrying the CLI's stderr guidance.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design notes

- **Consumer-only.** The tool runtime-injects only `tools`, `codeGraph`, and `systemPrompt`, imports no provider, and passes only `exec.signal` to the seam.
- **Validated discriminated input.** `parseCodeGraphArgs` returns an operation-discriminated union: each arm carries exactly its operation's required subject, so `buildSeamQuery` needs no defaulting and an unset refinement is simply absent from the seam query.
- **Budget from the cap.** `budgetForChars` derives the provider's `budgetTokens` as `maxResultChars / 4` (floored at one), keeping the model-facing lever and the provider's output bound in one configured place.
- **Caps after rendering.** `maxResultChars` bounds the complete rendered text including its truncation marker, mirroring the `lsp` tool's cap discipline; the canonical value keeps the provider's complete text and truncation fact untouched.
- **Generic search-card presentation.** `presentCodeGraphCall` renders a `{ card: 'generic', kind: 'search', title }` view from the operation and its subject; graph reports have no per-file locations to focus.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, tool registration, system-prompt section, execution |
| [`src/render.ts`](src/render.ts) | Pure parsing, validation, result capping, and UI presentation |
| [`src/session-cwd.ts`](src/session-cwd.ts) | Workspace root from the session `header.cwd` |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-codegraph](../codegraph/README.md) — the seam this tool queries.
- [dsh-astria](../astria/README.md) — the CLI provider that answers these queries.
- [codegraph group map](../README.md) — the three-package family and its related documentation.

-----

<a id="model-experience"></a>
## Model Experience

### System prompt

#### What the model sees

One system-prompt section (first-party order 2210) positions the graph as a repository-level aid with the following text:

##### Verbatim guidance

```markdown
Use search/read for ordinary navigation and lsp for precise symbol positions. Use code_graph for repository-level structure: an overview map, how two areas connect, or what a change impacts. The graph is built outside this tool; if it is missing, the error explains how to build it.
```

#### Token effect

Fixed guidance cost on every request while the plugin is active.

#### KV Cache effect

Prefix-stable while the plugin scope and guidance text are unchanged; activation or disposal may invalidate reuse from this section.

### Tool schema

#### What the model sees

The model sees the generated [`code_graph` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-codegraph).

#### Token effect

Fixed schema cost on every request while enabled; the `timeoutMs` budget and derived token budget are never sent to the model.

#### KV Cache effect

Prefix-stable while the visible tool definition and order are unchanged; registration lifecycle or scoped restrictions may invalidate reuse from the first changed schema token.

### Results

#### What the model sees

The provider's report text, capped in complete rendered characters with an in-cap truncation marker; a provider-side truncation gets its own tail marker and an empty report renders `No output.`. These caps affect only Native/model presentation, not the canonical value.

#### Token effect

Capped per tool result by `maxResultChars`, which also pre-bounds the provider's own output through the derived token budget.

#### KV Cache effect

Tool results append after the cached request prefix and do not directly invalidate it.

### UI presentation

#### What the model sees

Nothing. The client renders a generic search card whose title carries the operation and its subject; graph reports have no per-file locations to focus.

#### Token effect

Zero direct token effect because rendering is client-side only.

#### KV Cache effect

None; UI presentation is outside the model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the tool is a poor fit. They are current package constraints, not a task backlog.

- **No freshness guarantee** — the tool answers whatever graph the workspace currently holds; a stale graph returns stale structure until the model or a listener refreshes it.
- **Foreground fallback is timeout-bounded** — without a job registry or an owning agent, `build`/`update` run inside the turn under `timeoutMs`, which a large workspace can outgrow; raise the budget or compose `dsh-jobs` instead.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
