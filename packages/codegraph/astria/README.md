---
description: "The astria CLI provider for ctx.codeGraph: resolves the astria executable at load and answers every query with one complete child-process run through ctx.subprocess, with bounded collected output and structured exit failures, for users and maintainers composing local code-graph navigation."
kind: "package-reference"
---

# @deepseek-ai/dsh-astria

English | [中文](README.zh.md)

## Summary

Use `dsh-astria` to give agents repository-level graph answers from [astria](https://github.com/Nodesify/astria), a tool that turns a folder into a queryable knowledge graph. It resolves the astria executable at load (logging one best-effort `astria --version` diagnostic), registers the scope's sole `ctx.codeGraph` provider, and answers the six operations one-shot through `ctx.subprocess` or — with `transport: server` — through one pooled `astria mcp` child per workspace root. The package never installs or upgrades astria and runs no package manager: deployments install the CLI themselves, and graph builds are tool operations (`build`/`update`) or automatic (`autoUpdate`, on by default, and the missing-graph fallback).

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

Mount this provider when a deployment has the astria CLI and wants the harness to answer code-graph questions through it. It needs a subprocess provider for the same execution world, the `dsh-codegraph` seam and, for model access, `dsh-tool-codegraph`.

Install astria separately (`npm install -g @nodesify/astria`); the provider resolves the executable at every load, so an upgrade plus a harness restart picks up the new version, and a missing executable rejects activation loudly. The plugin has no `astria install` integration and never writes the CLI's configuration: composition stays on the harness side (patch layers, the [example overlay](../../../apps/cli/config/examples/codegraph-astria/astria.cordis.yml)).

### Minimal configuration

Nothing is required: the defaults run `astria` resolved on the scrubbed PATH and keep the graph current after agent edits (`autoUpdate`).

```yaml
- name: '@deepseek-ai/dsh-subprocess-local'
- name: '@deepseek-ai/dsh-codegraph'
- name: '@deepseek-ai/dsh-astria'
- name: '@deepseek-ai/dsh-tool-codegraph'
```

| Field | Default | Meaning |
|---|---|---|
| `command` | `astria` | Executable to run — absolute, or a bare name resolved on the scrubbed PATH at load |
| `args` | `[]` | Extra global arguments inserted before the operation subcommand |
| `env` | `{}` | Extra env merged over the credential-scrubbed ambient env; `KEY`/`PASSWORD`/`SECRET`/`TOKEN`-matching and `DSH_*` names are not forwarded |
| `maxOutputBytes` | `1000000` | In-memory cap for collected stdout per query; overflow keeps the tail and marks the result truncated |
| `maxStderrBytes` | `100000` | In-memory cap for the stderr tail included in exit failures |
| `killGraceMs` | `2000` | Termination grace for cancelled or disposed queries |
| `transport` | `cli` | `cli` runs one astria child per query; `server` keeps one pooled `astria mcp` stdio child per workspace root and answers queries through it (refresh always runs one-shot) |
| `serverTimeoutMs` | `30000` | MCP handshake and per-call budget for the `server` transport |
| `editContext.enabled` | `false` | After a successful watched edit, query the blast radius (`astria affected` on the edited path) and attach it as bounded model context |
| `editContext.tools` | `write`, `edit`, `str_replace_editor` | Tool names that count as edits for the attached context |
| `editContext.maxChars` | `2000` | Largest attached blast-radius context in characters |
| `orientation.enabled` | `false` | After a `compaction/end` event, inject one token-budgeted repo map as the session agent's next model-visible context |
| `orientation.budgetTokens` | `1000` | The injected repo map's token budget |
| `autoUpdate.enabled` | `true` | After a successful file-mutating tool result, start one debounced background `astria update` job owned by the editing agent and inject a notice when the refreshed graph lands; needs a job registry and the tool runtime composed |
| `autoUpdate.debounceMs` | `3000` | Quiet window after the last edit before the refresh job starts |
| `autoUpdate.tools` | `write`, `edit`, `str_replace_editor` | Tool names that count as edits |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-astria) is the exhaustive source for every accepted field.

### What a query does

Each query maps onto one astria subcommand (`map`, `query`, `explain`, `path`, `affected`, `stats`) with `--graph <root>` pinning the workspace; refinement fields become `--depth`, `--directed`, `--cursor`, and `--budget` flags. A missing graph fails as the structured `CODEGRAPH_NO_GRAPH` (matched on astria's stable "No graph found" stderr line), which the tool turns into an automatic background build. The child runs once with collected stdout/stderr; exit 0 returns the report text with its truncation fact, and any other exit fails as a structured `CODEGRAPH_EXIT` error whose message carries the bounded stderr tail — so a missing graph surfaces as the CLI's own guidance, not a silent empty result. Cancellation and plugin disposal terminate the child through the subprocess seam's managed range.

### Advisories

Two opt-in listeners extend the graph's reach beyond explicit calls. `editContext` attaches the blast radius of each watched edit (`astria affected` over the edited path) as bounded context on the edit's own result. `orientation` listens for `compaction/end` session events and injects one token-budgeted repo map as the compacted session's next model-visible context; both stay silent without a live agent or a graph.

### Refresh and automatic updates

`refresh` runs the same one-shot discipline over `astria run` (full pipeline) or `astria update` (incremental AST-only pass); callers own placement — the `code_graph` tool schedules builds as background jobs through `ctx.jobs` under this package's `codegraph` job kind. `autoUpdate` (on by default) adds a `tools/post-execute` listener that watches the configured file-mutating tools and starts one debounced, agent-owned background update per workspace after edits settle, injecting an `astria`-sourced notice the next request sees. The listener activates only where a job registry and the tool runtime are composed.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design notes

- **Two query transports.** `cli` runs one complete child per query: no pooled process and no protocol state, so a crashed run affects exactly its query. `server` pools one `astria mcp` stdio child per workspace root (newline JSON-RPC over the subprocess seam's piped streams, `lsp-stdio` shape): a dead or timed-out child is replaced once per query before the failure reaches the caller. Refresh always runs one-shot — the MCP server offers no build tool.
- **Load-time version diagnostic.** Activation spawns `astria --version` once and logs the line; a failed probe warns and never gates startup.
- **Execution-world pairing.** The executable resolves and the child runs through `ctx.subprocess`, so pointing the subprocess provider at a remote world moves graph queries with it.
- **Bounded collection, honest truncation.** stdout collects to `maxOutputBytes` keeping the tail; the result's `truncated` flag is the collect reader's `lossy` fact, so a consumer never mistakes a tailed report for the complete one.
- **Abort classification before exit classification.** A terminated child resolves `done` with signal exit facts; the provider checks its fused signal first so a caller cancellation or disposal surfaces as the abort reason, never as a fake astria failure.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, load-time executable resolution, sole-provider registration |
| [`src/args.ts`](src/args.ts) | Pure seam-request → astria argv mapping |
| [`src/provider.ts`](src/provider.ts) | One-shot query and refresh runner: spawn, collect, exit classification, disposal quiescence |
| [`src/server.ts`](src/server.ts) | The pooled MCP child: handshake, id-correlated calls, deadline retirement, teardown |
| [`src/server-provider.ts`](src/server-provider.ts) | Transport selection: server-backed queries over the CLI-backed refresh and disposal |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-codegraph](../codegraph/README.md) — the seam this provider registers against.
- [dsh-tool-codegraph](../tool-codegraph/README.md) — the model-facing tool over the seam.
- [codegraph group map](../README.md) — the three-package family and its related documentation.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-codegraph`, which surfaces this provider's bounded reports while this host contributes no prompt or schema itself.

#### KV Cache effect

No direct invalidation; `dsh-tool-codegraph` owns request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the provider is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **One process spawn per query on the CLI transport** — each query (and every refresh, on both transports) pays CLI startup (including SQLite open); latency-sensitive deployments switch to `transport: server`, which pools one child per workspace root and replaces a dead or timed-out child once before failing.
- **Human-oriented CLI output** — astria v1 has no machine-readable output flags, so results are the CLI's token-budgeted text verbatim; a `--json` surface upstream would let the seam grow structured result arms.
- **No confinement policy** — this package trusts the configured executable and adds no sandbox; a restricted deployment must supply appropriate subprocess providers or a same-world sandbox wrapper.
- **The missing-graph match is a stderr line** — `CODEGRAPH_NO_GRAPH` keys on astria's "No graph found" message text, so an upstream wording change degrades it to a plain `CODEGRAPH_EXIT` (the model still sees the CLI's guidance) rather than breaking anything.
- **Advisories are best-effort** — the blast radius and orientation listeners skip silently when no graph, agent, or (for orientation) live agent exists; they never fail a tool call.
- **Auto-update sees only tool-mediated edits** — the listener reacts to configured tool names (`write`, `edit`, `str_replace_editor` by default); shell-driven file changes reach the graph only through the model's next explicit refresh.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open design questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- astria releases quickly; the provider depends only on the six documented subcommands and flags, and a breaking upstream change surfaces as `CODEGRAPH_EXIT` with the CLI's own message rather than silent misbehavior.
- The upstream surface the integration rides is deliberately narrow: the six subcommands and their flags, the "No graph found" stderr line, and (server transport) the MCP tool schemas. Upstream additions that would grow the integration — machine-readable output (`--json`) for structured results, CLI parity for `god_nodes`/`list_communities`/`get_neighbors`, and graph-builder metadata for a true freshness probe — are wanted, not assumed; none blocks what ships today. An `astria install` platform target for dsh was considered and dropped: composition belongs to the harness's own layering.

</details>
