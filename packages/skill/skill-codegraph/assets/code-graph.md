# Code-graph navigation

When the `code_graph` tool is available, prefer the graph over raw file scanning for structure, connectivity, and change impact. The graph is a prebuilt knowledge graph of the repository (built and refreshed by astria); queries are cheap and token-budgeted, and they answer questions that grep cannot.

## When to use the graph

| Question | Action |
|---|---|
| What is this repository's shape? | `repoMap` first — a ranked map of files and top symbols within a token budget. |
| How does X work / connect to Y? | `query` with natural-language terms; follow up with `explain` on a specific node. |
| What breaks if I change X? | `affected` on the symbol or file path BEFORE editing — the blast radius is reverse reachability. |
| How do A and B relate? | `path` traces the shortest connection; `directed` follows only caller-to-callee edges. |
| Which symbols/files hold the graph together? | `hubs` lists the highest-degree nodes — the load-bearing places to treat carefully. |
| What are the major subsystems? | `communities` lists detected clusters with their size and cohesion. |
| Is the graph healthy and current? | `stats` reports node, edge, community, and file counts; `status` reports staleness, which astria built the graph, and whether it predates the current extraction rules. |
| Can the user view the graph? | `export` writes an html page or svg image and reports its path. |

## Workflow rules

1. **Orient before diving.** In an unfamiliar repository, call `repoMap` before reading files; it ranks files by importance so you read what matters first.
2. **Check the blast radius before risky edits.** Run `affected` on the file or symbol you plan to change; if the radius is wide, read the impacted nodes before editing.
3. **Page deep results.** A truncated `query` result shows a continuation token — repeat the call with `cursor` to get the next slice instead of re-querying.
4. **Graph for structure, search for text, lsp for symbols.** Use `search`/`read` for exact text, `lsp` for a symbol's definition/references at a position, and the graph for repository-level relationships. Do not use the graph to locate a single definition.
5. **A missing graph is not fatal.** If a query reports no graph, call `build` (a background job starts and the result says when to retry) or ask the user to run `astria run .`.
6. **Trust a current graph, refresh a stale one.** Before answering from a graph you did not build this session, `status` tells you its age, build time, and tool versions; a stale or extraction-outdated answer means `update` before trusting structure-sensitive conclusions.

## After editing

If the deployment enables automatic updates, the graph refreshes itself after your edits and a notice confirms it. Otherwise, run `update` after substantial edits so later queries see current structure.
