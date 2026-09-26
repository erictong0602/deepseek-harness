---
description: "ctx.codeGraph 的 astria CLI 提供方：加载时解析 astria 可执行文件，通过 ctx.subprocess 以每次查询一次完整子进程运行的方式回答查询，输出有界收集并以结构化退出失败呈现，供组合本地代码图导航的用户与维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-astria

[English](README.md) | 中文

## 概述

当部署装有 [astria](https://github.com/Nodesify/astria)（一个把目录变成可查询知识图的工具）时，使用 `dsh-astria` 为 agent 提供仓库级图回答。它在加载时解析 astria 可执行文件，注册作用域唯一的 `ctx.codeGraph` 提供方，并通过 `ctx.subprocess` 每次完整运行一次 astria CLI 来回答六个操作。本包不安装 astria，也不构建图：部署方自行提供可执行文件并运行 `astria run .`（或 `astria watch .`）。

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

当部署装有 astria CLI 并希望 harness 通过它回答代码图问题时挂载本提供方。它需要同一执行世界的子进程提供方、`dsh-codegraph` 接缝，以及模型访问所需的 `dsh-tool-codegraph`。

### 最小配置

无需任何配置：默认在清洗后的 PATH 上解析并运行 `astria`。

```yaml
- name: '@deepseek-ai/dsh-subprocess-local'
- name: '@deepseek-ai/dsh-codegraph'
- name: '@deepseek-ai/dsh-astria'
- name: '@deepseek-ai/dsh-tool-codegraph'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `command` | `astria` | 待运行的可执行文件 — 绝对路径，或加载时在清洗后 PATH 上解析的裸名称 |
| `args` | `[]` | 插入在操作子命令之前的额外全局参数 |
| `env` | `{}` | 合并在凭据清洗后环境之上的额外环境变量；匹配 `KEY`/`PASSWORD`/`SECRET`/`TOKEN` 的名字与 `DSH_*` 名字不被转发 |
| `maxOutputBytes` | `1000000` | 每次查询收集 stdout 的内存上限；溢出保留尾部并将结果标记为截断 |
| `maxStderrBytes` | `100000` | 退出失败中包含的 stderr 尾部上限 |
| `killGraceMs` | `2000` | 取消或释放查询的终止宽限 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-astria)是每个可接受字段的详尽来源。

### 一次查询做什么

每个查询映射为一个 astria 子命令（`map`、`query`、`explain`、`path`、`affected`、`stats`），`--graph <root>` 固定工作区；细化字段变成 `--depth`、`--directed` 与 `--budget` 标志。子进程运行一次并收集 stdout/stderr；退出码 0 返回报告文本及其截断事实，任何其他退出都作为结构化 `CODEGRAPH_EXIT` 错误失败，其消息携带有界的 stderr 尾部 — 因此缺失的图以 CLI 自身的指引呈现，而不是无声的空结果。取消与插件释放通过子进程接缝的托管范围终止子进程。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

### 设计要点

- **每次查询一个完整子进程。** 没有进程池也没有协议状态：一次 CLI 崩溃只影响它那次查询，提供方在查询之间保持无状态。代价是每次查询一次进程派生。
- **执行世界配对。** 可执行文件通过 `ctx.subprocess` 解析和运行，因此把子进程提供方指向远程世界时，图查询随之迁移。
- **有界收集与诚实的截断。** stdout 以 `maxOutputBytes` 收集并保留尾部；结果的 `truncated` 标志即收集读取器的 `lossy` 事实，因此消费者不会把尾部报告误当作完整报告。
- **先归类中止再归类退出。** 被终止的子进程以信号退出事实结算 `done`；提供方先检查融合信号，因此调用方取消或释放以中止原因呈现，绝不会伪装成 astria 失败。

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、加载时可执行文件解析、单提供方注册 |
| [`src/args.ts`](src/args.ts) | 纯粹的接缝请求 → astria argv 映射 |
| [`src/provider.ts`](src/provider.ts) | 一次性查询运行器：派生、收集、退出归类、释放静默 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [dsh-codegraph](../codegraph/README.zh.md) — 本提供方注册的接缝。
- [dsh-tool-codegraph](../tool-codegraph/README.zh.md) — 接缝之上的模型可见工具。
- [codegraph 组导航](../README.zh.md) — 三包家族及相关文档。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 `dsh-tool-codegraph` 呈现本提供方的有界报告，而本宿主自身不贡献任何提示或 schema。

#### KV Cache 影响

无直接失效；`dsh-tool-codegraph` 拥有请求前缀的变更。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

这些限制定义本提供方何时是糟糕的选择或需要特别的运维关注。它们是当前的包约束，不是任务积压。

- **每次查询一次进程派生** — 每次查询都付出 CLI 启动（包括打开 SQLite）；延迟敏感的部署应等待下方的常驻服务端变体。
- **面向人类的 CLI 输出** — astria v1 没有机器可读的输出标志，因此结果是 CLI 按令牌预算生成的文本原样；上游提供 `--json` 表面后，接缝才能生长出结构化结果分支。
- **没有约束策略** — 本包信任配置的可执行文件，不添加沙箱；受限部署必须提供合适的子进程提供方或同世界沙箱包装。
- **延后：常驻服务端提供方** — 以 `lsp-stdio` 的形态把 `astria mcp` 作为池化 stdio 进程运行可消除每次查询的派生开销；接缝无需为此变更。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文 — 点击展开</summary>

本开发备忘是面向维护者的工作上下文：尚未决定的开放设计问题与方向。它明确不具权威性 — 已交付的行为、限制与接受的依据保存在上方章节、包代码与链接的 Agent Note 中。

- astria 发布节奏很快；本提供方只依赖六个已文档化的子命令与标志，上游的破坏性变更会以携带 CLI 自身消息的 `CODEGRAPH_EXIT` 呈现，而不是无声的错误行为。

</details>
