---
description: "The dedicated code_graph tool row for the dsh web client: the call card and the viewable graph-artifact action a settled export carries."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-codegraph

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-codegraph` renders every `code_graph` call in the conversation as a dedicated expandable row, and a settled export adds the action that matters: one click loads the graph view artifact (the interactive HTML page or static SVG `astria export` wrote) through the session-authorized workspace-files remote and opens it in a new browser tab. The Client ships no graph renderer — the browser renders astria's own self-contained artifact. No runtime invariant companion is published; the row renders frozen call slices and owns no diverging runtime observations.

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

Mount this browser plugin beside the Tool conversation layer and the remotes bundle; the astria [example overlay](../../../apps/cli/config/examples/codegraph-astria/astria.cordis.yml) composes it, and no default dsh bundle does. Every `code_graph` tool call then renders through the dedicated row instead of the generic Tool row, and export results gain their open action.

### The call row

The `preparing` stage shows the row glyph and title only. The `start` and `result` stages derive everything from the frozen call/result slice: the collapsed summary names the operation and its subject (the query question, node, path endpoints, or export format), failures replace the subject with the first error line, and interruptions keep their explicit status text. An expandable settled row discloses the exact durable tool output with the standard trajectory `Inspect` affordance when available.

### The view action

A settled, non-error call whose persisted result meta names an export artifact renders the `View graph` action inside the expanded row. Clicking it resolves the artifact's bytes through `remote.workspaceFiles.readBytes` addressed by the Session identity, wraps them as a `text/html` or `image/svg+xml` blob, and opens the blob URL in a new tab (`noopener`); a failed load (the artifact is gone on replay, or exceeds the remote's full-file cap) swaps the action copy to a failure line without breaking the row. The action is best-effort and never touches the model transcript.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design notes

- **Replay-stable derivation.** The row model reads only the frozen call slice: arguments for the subject, settled content for the disclosure, and persisted `meta` (the tool's `output.presentationMeta` projection) for the export target — never live session or graph state, so a session-log replay reproduces the row exactly.
- **Client-side narrowing.** The opaque `meta` is narrowed locally (`kind: 'export'`, `html`/`svg` format, non-empty workspace-relative path); malformed or older metadata degrades to the row without the action, and the plugin imports no Host tool implementation.
- **Session-addressed loading.** The artifact bytes load through the same session-authorized remote the file views use, so the click works for any workspace world the Host serves; the opened blob URL is revoked after the tab has loaded it.
- **Locale-owned copy.** All row copy lives in the `codegraph` namespace dictionaries (zh is the key-set source of truth; en is checked complete against it).

### Registration

The browser half registers its dictionaries through `ctx.locale.register` and one keyed `tool.call.toolview` entry for the wire name `code_graph`; disposal of the plugin fiber removes both (HMR-safe).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-tool-codegraph](../../../packages/codegraph/tool-codegraph/README.md) — the `code_graph` tool whose results this row renders.
- [dsh-astria](../../../packages/codegraph/astria/README.md) — the provider whose export operation writes the artifact.
- [dsh-api-workspace-files](../../api/workspace-files/README.md) — the session-addressed remote the action loads bytes through.

-----

<a id="model-experience"></a>
## Model Experience

None, as this plugin renders tool results client-side and never constructs model input.

#### KV Cache effect

None; the plugin changes no model-request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the row is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **The action renders only what the tool recorded** — it opens the deterministic artifact path persisted in result meta; a later manual rebuild that moved or deleted the file surfaces as the failure copy, and the row cannot browse other exports.
- **Blob-URL opening is browser-native** — the artifact opens in a new tab of the app's browser context; embedded rendering (an in-app graph pane) would be a separate surface with its own confinement story.
- **Full-file cap applies** — the bytes load under the workspace-files remote's configured `maxFileBytes` (default 32 MB); a dramatically larger export fails into the same failure copy.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open design questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- An in-app artifact pane (sandboxed iframe over the same blob URL) was considered and deferred: the new-tab flow needs no new confinement surface and reuses astria's own viewer verbatim.

</details>
