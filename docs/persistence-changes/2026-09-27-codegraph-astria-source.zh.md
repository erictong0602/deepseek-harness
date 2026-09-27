---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-27-codegraph-astria-source

[English](2026-09-27-codegraph-astria-source.md) | 中文

## 概述

astria 代码图提供方向可合并扩展的用户消息来源映射新增一个署名种类：后台图刷新注入一条署名为新 astria 种类的用户消息。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

MessageSourceMap 是可合并扩展的和类型，MessageSource 消费者按契约对未知种类走默认分支，因此既有读取方将 astria 种类视为普通的提供方署名；没有任何已存储字段改变形态，也不涉及迁移。

<a id="verification"></a>
## 验证

运行 astria 自动更新套件（监听器调度更新任务、所属 agent 收到注入通知）与全部 codegraph 套件；持久化 schema 已带 @persistenceAttribution 标注重新生成，verify-persistence-changes 在记录历史之上通过。

<a id="dev-note"></a>
## 开发备注

无。
