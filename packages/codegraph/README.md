---
description: "The codegraph group map: repository code-graph navigation through the codeGraph seam, its astria CLI provider, and the model-facing code_graph tool, for users and maintainers navigating the group."
kind: "package-group"
---

# codegraph/ — repository code graphs

English | [中文](README.zh.md)

## Summary

The codegraph group lets agents answer repository-level questions through a code knowledge graph: an overview map ranked by importance, natural-language queries, symbol explanations, shortest paths, and the blast radius of a change — plus background builds, incremental refreshes, and optional post-edit auto-updates. Use `astria/` to query and refresh by running the astria CLI, and `tool-codegraph/` to expose both to the model. The shared `codegraph/` package keeps provider choice and normalized results consistent, so changing the graph backend does not change model requests. Deployments install the backend; this group ships neither binaries nor prebuilt graphs.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`codegraph/`](codegraph/README.md) | Defines the code-graph service: a sole-provider registry over six normalized read-only operations with bounded text results and structured errors | `ctx.codeGraph` |
| [`astria/`](astria/README.md) | Answers `ctx.codeGraph` queries by running the configured astria CLI once per query through `ctx.subprocess` | registers on `ctx.codeGraph` |
| [`tool-codegraph/`](tool-codegraph/README.md) | Exposes repository-level graph questions to the model through the `code_graph` tool | registers on `ctx.tools` |

Providers register capabilities, not tools: `tool-codegraph` is the only owner of the model-facing name, schema, prompt guidance, and presentation, so swapping a provider never changes how the model asks graph questions.

-----

<a id="related-documentation"></a>
## Related documentation

- [Generated tool catalog](../../docs/tool-catalog.md#deepseek-aidsh-tool-codegraph) — the `code_graph` schema the model receives.
- [LSP navigation subsystem](../../docs/subsystems/lsp.md) — the symbol-level precision navigation this group complements.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
