---
description: "The bundled code-graph navigation skill: graph-first guidance (repo maps, blast-radius checks, cursor paging) loaded on demand through the session skill catalog for repositories with an astria knowledge graph, for users and maintainers composing model guidance."
kind: "package-reference"
---

# @deepseek-ai/dsh-skill-codegraph

English | [中文](README.zh.md)

## Summary

`dsh-skill-codegraph` bundles one skill, `code-graph`, that teaches an agent to navigate a repository through its astria knowledge graph: repo maps for orientation, natural-language architecture queries, blast-radius checks before risky edits, and cursor paging for deep results. The guidance loads on demand through the session skill catalog instead of spending standing prompt tokens, and it names when to prefer `search`/`read` and `lsp` instead. Mount it beside `dsh-tool-codegraph`; the skill text assumes the `code_graph` tool is available and never replaces it.

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

Mount the package wherever the skill catalog runs and the `code_graph` tool is composed. The provider registers one bundled candidate; loading the full instructions happens only when the model or the user invokes the skill.

```yaml
- name: '@deepseek-ai/dsh-skill'
- name: '@deepseek-ai/dsh-skill-filesystem'
- name: '@deepseek-ai/dsh-skill-codegraph'
- name: '@deepseek-ai/dsh-tool-codegraph'
```

The skill is model-invocable (`/code-graph` also reaches it directly where user invocation is enabled). Its body lives in [`assets/code-graph.md`](assets/code-graph.md) and stays a bundled resource: editing it edits the skill every composition serves.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

- **One static candidate.** The provider lists one `SkillCandidate` with `source: 'bundled'` and the shared bundled rank; `get` reads the asset body at invocation time, so the markdown is the single source of truth.
- **Guidance, not enforcement.** The skill steers model behavior (orient, check blast radius, page cursors); the tool's own prompt section carries the standing one-line positioning, and the two are deliberately non-overlapping.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-tool-codegraph](../../codegraph/tool-codegraph/README.md) — the `code_graph` tool this skill teaches.
- [Skill subsystem](../../../docs/subsystems/skills.md) — the registry, provider contract, and catalog.
- [codegraph group map](../../codegraph/README.md) — the capability family behind the tool.

-----

<a id="model-experience"></a>
## Model Experience

### Skill catalog entry

#### What the model sees

The catalog carries the skill's name, one-paragraph description, and invocation flags; the full body enters context only on invocation through the `skill` tool.

#### Token effect

A bounded catalog row while listed; the body's cost applies only to turns that load it.

#### KV Cache effect

The catalog row is stable while the skill is registered; loading the body appends context without invalidating the cached prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the skill is a poor fit. They are current package constraints, not a task backlog.

- **The guidance cannot verify tool availability** — the catalog entry always lists; a composition without `dsh-tool-codegraph` shows the model a skill whose tool is absent, and the body says to fall back to search and read.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
