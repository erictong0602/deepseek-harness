---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-27-codegraph-astria-source

English | [中文](2026-09-27-codegraph-astria-source.zh.md)

## Summary

The astria code-graph provider adds one attribution kind to the merge-extensible user-message source map: background graph refreshes inject a user message attributed to the new astria kind.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-27-codegraph-astria-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-16-session-format-v4"
    after: "6f42adfb582d3c61d8e5b1e7665090e2c396f01cd149fd0c55596d4467d1a216"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-16-session-format-v4"
    after: "97b6c4485e456745144d97d15ce1ec72cd6b8f36709efe47c6b5a4bf5c4d801c"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-16-session-format-v4"
    after: "0986eb72dc4df3e4f6cc42b0296f6d914d8f930c829ed0e72ade9e82f2a7bf53"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-16-session-format-v4"
    after: "f746e35669cf23c82d5dfd3bd28491a2e3f0d3fa3a13072b43a00ec14dbd4ca2"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

MessageSourceMap is a merge-extensible sum type and MessageSource consumers fall through unknown kinds by contract, so existing readers treat the astria kind as any other producer attribution; no stored field changes shape and no migration is involved.

<a id="verification"></a>
## Verification

Ran the astria auto-update suite (listener schedules the update job, the owning agent receives the injected notice) and the full codegraph suites; persistence schema regenerated with the astria member marked @persistenceAttribution, and verify-persistence-changes passes over the recorded history.

<a id="dev-note"></a>
## Dev Note

None.
