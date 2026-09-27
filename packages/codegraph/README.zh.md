---
description: "codegraph 组导航：通过 codeGraph 服务定义、astria CLI 提供方与模型可见的 code_graph 工具完成仓库级代码图查询，供浏览本组的用户与维护者使用。"
kind: "package-group"
---

# codegraph/ — 仓库代码图

[English](README.md) | 中文

## 概述

codegraph 组让 agent 通过代码知识图回答仓库级问题：按重要性排序的概览图、自然语言查询、符号解释、最短路径，以及一处变更的影响范围 — 还有后台构建、增量刷新与可选的编辑后自动更新。使用 `astria/` 通过运行 astria CLI 查询与刷新，使用 `tool-codegraph/` 把二者提供给模型。共享的 `codegraph/` 包保证提供方选择与归一化结果的一致性，因此更换图后端不会改变模型请求。部署方自行安装后端；本组既不提供二进制，也不提供预构建的图。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备忘](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`codegraph/`](codegraph/README.zh.md) | 定义代码图服务：单提供方注册表、六个归一化只读操作、有界文本结果与结构化错误 | `ctx.codeGraph` |
| [`astria/`](astria/README.zh.md) | 通过 `ctx.subprocess` 每次查询完整运行一次 astria CLI 来响应 `ctx.codeGraph` | 注册于 `ctx.codeGraph` |
| [`tool-codegraph/`](tool-codegraph/README.zh.md) | 通过 `code_graph` 工具向模型提供仓库级图问题 | 注册于 `ctx.tools` |

提供方注册的是能力而非工具：`tool-codegraph` 是模型可见名称、schema、提示指引与呈现的唯一所有者，因此更换提供方不会改变模型提问图问题的方式。

-----

<a id="related-documentation"></a>
## 相关文档

- [生成的工具目录](../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-codegraph) — 模型收到的 `code_graph` schema。
- [LSP 导航子系统](../../docs/subsystems/lsp.zh.md) — 本组补充的符号级精确导航。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>面向维护者的工作上下文 — 点击展开</summary>

无。

</details>
