---
description: "内置的代码图导航技能：为装有 astria 知识图的仓库提供图优先指引（仓库图、影响范围检查、游标续读），经会话技能目录按需加载，供组合模型指引的用户与维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-skill-codegraph

[English](README.md) | 中文

## 概述

`dsh-skill-codegraph` 内置一个技能 `code-graph`，教 agent 通过 astria 知识图导航仓库：用于定向的仓库图、自然语言架构查询、风险编辑前的影响范围检查，以及深度结果的游标续读。该指引经会话技能目录按需加载，而不是常驻消耗提示词令牌，并明确说明何时应改用 `search`/`read` 与 `lsp`。与 `dsh-tool-codegraph` 一同挂载；技能文本假设 `code_graph` 工具可用，且从不替代它。

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

在技能目录运行且组合了 `code_graph` 工具的任何地方挂载本包。提供方注册一个内置候选项；只有模型或用户调用该技能时才加载完整指引。

```yaml
- name: '@deepseek-ai/dsh-skill'
- name: '@deepseek-ai/dsh-skill-filesystem'
- name: '@deepseek-ai/dsh-skill-codegraph'
- name: '@deepseek-ai/dsh-tool-codegraph'
```

该技能可由模型调用（在启用用户调用的地方，`/code-graph` 也可直达）。其正文保存在 [`assets/code-graph.md`](assets/code-graph.md)，是纯粹的内置资源：编辑它即修改所有组合提供的技能。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

- **单一静态候选。** 提供方列出 `source: 'bundled'`、共享内置排名的一个 `SkillCandidate`；`get` 在调用时读取资源正文，markdown 是唯一事实来源。
- **指引而非强制。** 技能引导模型行为（先定向、查影响范围、游标续读）；工具自身的提示节承载常驻的一句话定位，二者刻意不重叠。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [dsh-tool-codegraph](../../codegraph/tool-codegraph/README.zh.md) — 本技能讲授的 `code_graph` 工具。
- [技能子系统](../../../docs/subsystems/skills.zh.md) — 注册表、提供方契约与目录。
- [codegraph 组导航](../../codegraph/README.zh.md) — 工具背后的能力系列。

-----

<a id="model-experience"></a>
## 模型体验

### 技能目录条目

#### 模型看到什么

目录携带技能的名称、一段式描述与调用标志；完整正文只在通过 `skill` 工具调用时进入上下文。

#### 令牌影响

列出期间是一行有界目录条目；正文成本只作用于加载它的回合。

#### KV Cache 影响

技能注册期间目录行保持稳定；加载正文追加上下文，不使缓存前缀失效。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

这些限制定义本技能何时是糟糕的选择。它们是当前的包约束，不是任务积压。

- **指引无法验证工具可用性** — 目录条目始终列出；没有 `dsh-tool-codegraph` 的组合会向模型展示一个工具缺失的技能，正文说明此时回退到 search 与 read。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文 — 点击展开</summary>

无。

</details>
