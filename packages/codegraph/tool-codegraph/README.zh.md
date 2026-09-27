---
description: "模型可见的 code_graph 工具：六个只读仓库级图操作，按操作校验参数、推导令牌预算并对完整结果按字符数封顶，供组合模型代码图问题的用户与维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-codegraph

[English](README.md) | 中文

## 概述

`dsh-tool-codegraph` 让模型通过一个工具提出仓库级问题并重建图：六个查询操作（概览仓库图、自然语言查询、符号解释、最短路径、影响范围、图统计）与两个刷新操作（`build`、`update`）。当任务注册表与所属 agent 存在时，刷新经 `ctx.jobs` 作为后台任务运行并立即返回任务 id，否则前台运行。参数按操作校验，结果以完整渲染字符数封顶，提供方的令牌预算由该上限推导。本包需要已注册的 `ctx.codeGraph` 提供方和会话工作区根目录；本工具用于仓库级结构，而非普通导航。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备忘](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当问题关于结构 — “改 X 会影响什么”、“这两个模块如何连接” — 而不是关于单个符号的定义时，agent 使用 `code_graph`。工具的提示指引将它与 `search`/`read` 和 `lsp` 区分开。

### 该工具

`code_graph` 接受 `operation`（`repoMap`、`query`、`explain`、`path`、`affected`、`stats`、`build` 或 `update`）以及操作的主题：`query` 用 `question`；`explain` 与 `affected` 用 `node`；`path` 用 `source` 与 `target`。`depth`（正整数）、`directed` 与 `cursor`（截断查询展示的续读令牌）细化遍历；`build` 与 `update` 不需要主题。对缺失图的查询不会走进死胡同：在存在任务注册表且启用刷新时，调用会启动后台构建并说明何时重试。提供方选择、令牌预算、后台放置、可执行文件与超时都留在模型输入之外。

### 模型得到什么

每个查询返回提供方的完整报告文本与 `truncated` 事实。渲染结果以完整字符数封顶，截断标记计入上限；提供方侧的截断有专属标记。空报告渲染为独立的 `No output.` 行，提供方失败以模型可读并可据以调整的错误文本到达 — 缺失的图会说明如何构建。后台刷新立即返回 `started background job <id>`；任务工具读取其输出与完成状态。

### 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `maxResultChars` | `16000` | 最大的完整渲染结果，含截断元数据；同时推导提供方的令牌预算 |
| `timeoutMs` | `60000` | 由 `dsh-tool-call-timeout-policy` 强制的工具调用超时预算；覆盖一次完整的前台提供方子进程运行，且不可由模型配置 |
| `allowRefresh` | `true` | 暴露 `build` 与 `update` 操作；被禁用的调用会响亮地失败而不是无声跳过 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-codegraph)是每个可接受字段的详尽来源。

### 失败与恢复

本工具需要会话工作区根目录（`header.cwd`），没有回退；缺失时在任何查询之前以 `CODEGRAPH_WORKSPACE_REQUIRED` 失败。没有注册提供方时以 `CODEGRAPH_UNAVAILABLE` 失败，astria 运行失败以携带 CLI stderr 指引的 `CODEGRAPH_EXIT` 到达。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

### 设计要点

- **仅消费者。** 工具只在运行时注入 `tools`、`codeGraph` 与 `systemPrompt`，不导入任何提供方，只把 `exec.signal` 传给接缝。
- **校验后的判别输入。** `parseCodeGraphArgs` 返回按操作判别的联合类型：每个分支恰好携带其操作所需的主题，因此 `buildSeamQuery` 无需任何默认，未设置的细化字段在接缝查询中根本不存在。
- **预算来自上限。** `budgetForChars` 将提供方的 `budgetTokens` 推导为 `maxResultChars / 4`（至少为 1），把模型可见杠杆与提供方输出上限放在同一个配置位置。
- **渲染之后封顶。** `maxResultChars` 约束包含截断标记在内的完整渲染文本，镜像 `lsp` 工具的封顶纪律；规范值保持提供方的完整文本与截断事实不变。
- **通用搜索卡片呈现。** `presentCodeGraphCall` 从操作及其主题渲染 `{ card: 'generic', kind: 'search', title }` 视图；图报告没有可聚焦的逐文件位置。

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、工具注册、系统提示节、执行 |
| [`src/render.ts`](src/render.ts) | 纯粹的解析、校验、结果封顶与 UI 呈现 |
| [`src/session-cwd.ts`](src/session-cwd.ts) | 来自会话 `header.cwd` 的工作区根目录 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [dsh-codegraph](../codegraph/README.zh.md) — 本工具查询的接缝。
- [dsh-astria](../astria/README.zh.md) — 回答这些查询的 CLI 提供方。
- [codegraph 组导航](../README.zh.md) — 三包家族及相关文档。

-----

<a id="model-experience"></a>
## 模型体验

### 系统提示

#### 模型看到什么

一个系统提示节（第一方顺序 2210）以如下文本将图定位为仓库级辅助：

##### 逐字指引

```markdown
Use search/read for ordinary navigation and lsp for precise symbol positions. Use code_graph for repository-level structure: an overview map, how two areas connect, or what a change impacts. The graph is built outside this tool; if it is missing, the error explains how to build it.
```

#### 令牌影响

插件活跃时，每个请求固定承担该指引成本。

#### KV Cache 影响

插件作用域与指引文本不变时前缀稳定；激活或释放可能从本节开始使复用失效。

### 工具 schema

#### 模型看到什么

模型看到生成的 [`code_graph` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-codegraph)。

#### 令牌影响

启用时每个请求固定承担 schema 成本；`timeoutMs` 预算与推导的令牌预算从不发送给模型。

#### KV Cache 影响

可见工具定义与顺序不变时前缀稳定；注册生命周期或作用域限制可能从第一个变更的 schema 令牌开始使复用失效。

### 结果

#### 模型看到什么

提供方的报告文本，以完整渲染字符数封顶并带计入上限的截断标记；提供方侧截断有自己的尾部标记，空报告渲染为 `No output.`。这些上限只影响 Native/模型呈现，不影响规范值。

#### 令牌影响

每次工具结果受 `maxResultChars` 封顶，该上限还通过推导的令牌预算预先约束提供方自身的输出。

#### KV Cache 影响

工具结果追加在缓存的请求前缀之后，不直接使其失效。

### UI 呈现

#### 模型看到什么

无。客户端渲染通用搜索卡片，标题携带操作及其主题；图报告没有可聚焦的逐文件位置。

#### 令牌影响

零直接令牌影响，因为渲染仅发生在客户端。

#### KV Cache 影响

无；UI 呈现在模型请求之外。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

这些限制定义本工具何时是糟糕的选择。它们是当前的包约束，不是任务积压。

- **没有新鲜度保证** — 工具回答工作区当前持有的图；在模型或监听器刷新之前，过期的图返回过期的结构。
- **前台回退受超时约束** — 没有任务注册表或所属 agent 时，`build`/`update` 在回合内受 `timeoutMs` 约束运行，大型工作区可能超出该预算；应提高预算或组合 `dsh-jobs`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文 — 点击展开</summary>

无。

</details>
