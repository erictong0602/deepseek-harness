---
description: "dsh Web 客户端的专用 code_graph 工具行：调用卡片，以及已完成的导出所携带的可查看图工件操作。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-codegraph

[English](README.md) | 中文

## 概述

`dsh-client-ui-codegraph` 把会话中的每个 `code_graph` 调用渲染为一条专用的可展开行，并且一次完成的导出会附带真正有用的操作：点击即通过会话授权的 workspace-files 远程加载图视图工件（`astria export` 写出的交互式 HTML 页面或静态 SVG），并在新的浏览器标签页中打开。客户端不内置图渲染器 — 由浏览器渲染 astria 自己的自包含工件。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把本浏览器插件与 Tool 会话层、remotes 组合挂载在一起；随附的 Web patch 已组合它。此后每个 `code_graph` 工具调用都通过专用行渲染，取代通用 Tool 行，并且导出结果获得打开操作。

### 调用行

`preparing` 阶段只显示行图标与标题。`start` 与 `result` 阶段的一切都从冻结的调用/结果切片推导：折叠摘要在命名操作及其主题（query 的问题、节点、path 两端或导出格式），失败时以第一条错误行替代主题，中断保留显式状态文案。可展开的已完成行披露精确的持久化工具输出，并在可用时附带标准的轨迹 `Inspect` 操作。

### 查看操作

结果元数据声明了导出工件的已完成、非错误调用，在展开行内渲染 `查看图` 操作。点击后通过以会话身份寻址的 `remote.workspaceFiles.readBytes` 解析工件字节，包装为 `text/html` 或 `image/svg+xml` blob，并在新标签页中打开该 blob URL（`noopener`）；加载失败（重放时工件已消失，或超出远程的全文件上限）只会把操作文案换成失败行，不会破坏该行。该操作尽力而为，绝不触及模型转录。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

### 设计要点

- **重放稳定的推导。** 行模型只读取冻结的调用切片：参数提供主题，已完成内容提供披露，持久化 `meta`（工具的 `output.presentationMeta` 投影）提供导出目标 — 绝不读取实时会话或图状态，因此会话日志重放能精确复现该行。
- **客户端侧收窄。** 不透明的 `meta` 在本地收窄（`kind: 'export'`、`html`/`svg` 格式、非空的工件相对路径）；畸形或较旧的元数据退化为不带操作的行，并且本插件不导入任何宿主工具实现。
- **会话寻址的加载。** 工件字节通过与文件视图相同的会话授权远程加载，因此点击对宿主服务的任何工作区世界都有效；打开的 blob URL 在标签页加载后被回收。
- **文案归语言所有。** 所有行文案位于 `codegraph` 命名空间词典（zh 是键集事实源；en 对照 zh 检查完整性）。

### 注册

浏览器半部通过 `ctx.locale.register` 注册词典，并为线名 `code_graph` 注册一个带键的 `tool.call.toolview` 条目；插件 fiber 的释放会同时移除二者（HMR 安全）。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [dsh-tool-codegraph](../../../packages/codegraph/tool-codegraph/README.zh.md) — 本行渲染其结果的 `code_graph` 工具。
- [dsh-astria](../../../packages/codegraph/astria/README.zh.md) — 其导出操作写出工件的提供方。
- [dsh-api-workspace-files](../../api/workspace-files/README.zh.md) — 操作通过它加载字节的会话寻址远程。

-----

<a id="model-experience"></a>
## 模型体验

无，本插件只在客户端渲染工具结果，从不构造模型输入。

#### KV Cache 影响

无；本插件不改变任何模型请求前缀。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

这些限制定义了该行何时是不合适的选择或需要特别的运维注意。它们是当前包约束，而非任务积压。

- **操作只呈现工具记录的内容** — 它打开持久化在结果元数据中的确定性工件路径；之后的手动重建若移动或删除了文件，只会呈现为失败文案，该行无法浏览其他导出。
- **blob URL 打开是浏览器原生行为** — 工件在应用浏览器上下文的新标签页中打开；内嵌渲染（应用内图面板）会是需要自身隔离故事的独立表面。
- **全文件上限生效** — 字节在 workspace-files 远程配置的 `maxFileBytes`（默认 32 MB）之下加载；显著更大的导出会落入相同的失败文案。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文 — 点击展开</summary>

本开发备忘是面向维护者的工作上下文：尚未决定的开放设计问题与方向。它明确是非权威的 — 已交付的行为、限制与已接受的依据位于上文各节、包代码与链接的 Agent Notes。

- 曾考虑应用内工件面板（基于同一 blob URL 的沙箱 iframe）并已延后：新标签页流程无需新的隔离表面，并原样复用 astria 自己的查看器。

</details>
