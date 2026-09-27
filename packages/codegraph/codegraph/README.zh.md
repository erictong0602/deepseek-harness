---
description: "代码图服务定义（ctx.codeGraph）：单提供方注册表、十个归一化仓库级操作、有界文本结果与 CodeGraphError 错误分类，供组合代码图导航的用户与维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-codegraph

[English](README.md) | 中文

## 概述

`dsh-codegraph` 定义代码图能力接缝：一个作用域至多持有一个提供方，查询是十个归一化只读操作，结果是有界文本并带显式截断事实，`export` 额外把可查看的图工件写入调用方持有的目的地。组合代码图后端或消费者时使用本包；参考提供方见 [`dsh-astria`](../astria/README.zh.md)，模型可见工具见 [`dsh-tool-codegraph`](../tool-codegraph/README.zh.md)。符号级导航属于 `ctx.lsp`，不属于本接缝。未发布运行时不变量配套包的说明：唯一提供方槽位与错误分类由 Service 契约及其测试强制执行。

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

当提供方或消费者需要 `ctx.codeGraph` 时挂载本包。提供方预留作用域的唯一槽位；第二个注册以 `CODEGRAPH_CONFLICT` 失败，因此选择永不依赖注册顺序，注册纤程的释放会归还槽位。没有提供方时查询以 `CODEGRAPH_UNAVAILABLE` 失败。

```ts
import type { Context } from '@deepseek-ai/cordis'
import { CodeGraphProviderId } from '@deepseek-ai/dsh-codegraph'
import type { CodeGraphQueryRequest, CodeGraphRefreshRequest, CodeGraphResult } from '@deepseek-ai/dsh-codegraph'
import '@deepseek-ai/dsh-codegraph'

export const name = 'my-codegraph-provider'
export const inject = ['codeGraph']

export function apply(ctx: Context): void {
  ctx.codeGraph.registerProvider({
    id: CodeGraphProviderId('my-backend'),
    async query(request: CodeGraphQueryRequest): Promise<CodeGraphResult> {
      // answer request.query (one of the ten operations) for request.root
      return { kind: 'text', text: 'report', truncated: false }
    },
    async refresh(request: CodeGraphRefreshRequest): Promise<CodeGraphResult> {
      // rebuild (mode 'build') or incrementally update (mode 'update') request.root
      return { kind: 'text', text: 'rebuilt', truncated: false }
    },
  })
}
```

每个请求都携带待查询工作区的 `root`；提供方在自己的执行世界中解析它。细化字段（`depth`、`directed`、`budgetTokens`）是可选的；无法满足某一字段的提供方应忽略它而不是失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

- **单提供方槽位。** 每个作用域一个提供方：第二个注册在任何变更之前抛出 `CODEGRAPH_CONFLICT`，槽位的释放器随注册纤程一同归还。这镜像了单提供方接缝（会话标题）而非 `ctx.lsp` 的按扩展名表，因为一个工作区只有一张图，而不是每类文件一张。
- **封闭操作联合类型。** `CodeGraphQuery` 以十个操作判别，`CODEGRAPH_OPERATIONS` 是同包内保有的运行时元组，schema 枚举与校验器都从同一列表派生；新增操作是接缝、提供方与工具的编译期强制变更。九个操作以有界文本回答；`export` 携带其 `format` 与目的地 `out` 路径，因此放置始终归调用方所有。请求是 `{ root, query }` 包装，因此 root 永不被默认。
- **单臂结果联合。** `CodeGraphResult` 为 `{ kind: 'text', text, truncated }`；`truncated` 报告提供方自身的输出上限，区别于任何消费者侧的渲染上限。第二个变体（例如结构化位置）将让消费者按 `kind` 分支。
- **刷新由调用方调度。** `refresh` 运行提供方的构建流水线且从不自行决定放置：模型可见工具通过 `ctx.jobs` 将其移出回合，编辑后监听器自行调度。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [`dsh-astria`](../astria/README.zh.md) — 回答这些查询的 CLI 提供方。
- [`dsh-tool-codegraph`](../tool-codegraph/README.zh.md) — 接缝之上的模型可见消费者。
- [codegraph 组导航](../README.zh.md) — 三包家族及相关文档。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 `dsh-tool-codegraph` 呈现已注册提供方的归一化结果，而本定义自身不贡献任何提示或 schema。

#### KV Cache 影响

无直接失效；`dsh-tool-codegraph` 拥有请求前缀的变更。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

这些限制描述接缝不决定的内容。它们是当前的包约束，不是任务积压。

- **仅文本结果** — v1 将每个操作与刷新归一化为有界文本；结构化结果（位置、节点记录）需要同时扩展结果联合与其消费者。
- **没有新鲜度策略** — `refresh` 按需重建；判断图何时过期（监听、mtime 检查）留在消费者侧，过期的图仍会回答查询。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文 — 点击展开</summary>

无。

</details>
