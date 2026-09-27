# Agent Note: The codegraph astria family is a composable Cordis plugin seam

Status: implemented

English | [中文](2026-09-27-codegraph-astria-cordis-plugin-posture.zh.md)

## Problem

The astria code-graph integration could have been wired into the harness as a built-in procedure — a hardcoded tool in the agent loop, a provider mounted in every shipped bundle. The authors do not own dsh and intend to offer the integration as an independently published plugin, so the structure had to make that extraction mechanical: Cordis plugin conventions, registrations as effects, and opt-in composition. The code alone does not explain the boundary between a dsh-host plugin and a generic Cordis plugin, or why the plugin keeps a Cordis-internal event during activation.

## Decision

The family ships as a seam split on the dsh-lsp three-package pattern:

- `dsh-codegraph` — the Service Definition: a `Service` subclass merged onto `Context` as `ctx.codeGraph`, a sole-provider registry whose registration is an `ctx.effect()` returning a disposer, the closed ten-operation union, the `CodeGraphError` taxonomy, and the branded provider id. No provider or tool logic.
- `dsh-astria` — the provider plugin: `name`/`inject`/`Config`/`apply` per Cordis, resolves the astria executable eagerly at load (a missing executable rejects activation loudly), registers the sole provider through an effect whose disposer unregisters before child teardown. `autoUpdate` (on by default), `editContext`, and `orientation` are gated behind `ctx.inject` optional services and stay silent where the job registry, tool runtime, sessions, or agents are absent.
- `dsh-tool-codegraph` — the consumer: `defineTool`, per-operation argument validation, token budget derived from the result cap, background builds through `ctx.jobs` under this family's `codegraph` job kind.
- `dsh-skill-codegraph` — the bundled navigation skill registered on `ctx.skills`.
- `dsh-client-ui-codegraph` — the conversation row (host `apply` is a no-op; the browser half ships via `dsh.client`).

Composition is opt-in. No dsh bundle or profile mounts any of the five packages; the codegraph UI row was removed from the `web-app` bundle and its manifest because it belongs to the astria family, and the [example overlay](../../../../apps/cli/config/examples/codegraph-astria/astria.cordis.yml) now composes all five. The astria packages are not a built-in procedure: they are third-party-shaped plugins that happen to live in this repository.

Every package is a genuine Cordis plugin; "dsh-host plugin" versus "generic Cordis plugin" is a difference in the injected service vocabulary, not in Cordis conformance. A dsh-host plugin injects dsh-owned services (`subprocess`, `jobs`, `tools`, `agents`, `sessions`, `llm`), extends dsh-owned type maps (`JobKindMap`, `MessageSourceMap`), and therefore requires a host that supplies the dsh service set. A generic Cordis plugin depends only on Cordis core and its own published services and runs on any Cordis host. Being dsh-host-coupled does not block a plugin-market listing — the manifest's `inject` and `peerDependencies` are the contract a market serves — but it does bound portability to dsh-service hosts.

Activation stays eager and fail-loud. The plugin observes its own unload through Cordis's declared built-in `internal/plugin` event (a fiber's uid was cleared) and aborts the pending executable resolution, because Cordis runs effect cleanup only after an async `apply` callback returns and no public disposal event exists. This matches existing repo use of the same event and is not a protocol escape.

## Recorded sessions

Injected astria notices and orientation maps are model-visible user messages with an `astria` source kind, a same-version persistence addition acknowledged in [the astria-source persistence change](../../../../docs/persistence-changes/2026-09-27-codegraph-astria-source.md); readers that predate the kind fall through unknown message sources by contract.

## Alternatives considered

**Wire astria into the agent loop and ship it in default bundles.** Rejected: it couples a capability the authors do not own into dsh's release surface, contradicts the effect-registration rule, and forfeits the plugin-market intent. The UI row was briefly in the `web-app` bundle and was removed for the same reason.

**Resolve the executable lazily to drop the `internal/plugin` observer.** Rejected: it trades the documented load-time "missing executable rejects activation" contract for a per-query surprise, and `internal/plugin` is a declared built-in Cordis event already used by dsh core, so it is not a portability blocker.

**Shape the provider as a generic Cordis plugin with its own service vocabulary.** Deferred: it means owning the seam, a spawned-child abstraction, and the message-source model outside dsh; the seam split already isolates exactly those boundaries, so extraction can decide the target later without rework.

## Consequences

- The family lifts out of the repository mechanically: seam split, effect-scoped lifecycle, and injected services. Publishing under another scope still requires republishing the dsh service peers it injects (ten packages) or moving to the generic shape.
- Default dsh bundles carry no astria surface; a deployment enables the family with the example overlay (provider, tool, skill, and UI row).
- Session logs may carry an `astria`-sourced message attribution; the persistence schema records the acknowledgement.
- Any future standalone listing must state the host service requirements; the README install contract already does.