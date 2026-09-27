---
description: "ctx.codeGraph 的 astria CLI 提供方：加载时解析 astria 可执行文件，通过 ctx.subprocess 以每次查询一次完整子进程运行的方式回答查询，输出有界收集并以结构化退出失败呈现，供组合本地代码图导航的用户与维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-astria

[English](README.md) | 中文

## 概述

当部署装有 [astria](https://github.com/Nodesify/astria)（一个把目录变成可查询知识图的工具）时，使用 `dsh-astria` 为 agent 提供仓库级图回答。它在加载时解析 astria 可执行文件（记录一次尽力而为的 `astria --version` 诊断），注册作用域唯一的 `ctx.codeGraph` 提供方，并通过 `ctx.subprocess` 每次完整运行一次 astria CLI 来回答六个操作 — 或以 `transport: server` 为每个工作区根目录骑乘一个池化的 `astria mcp` stdio 子进程。本包从不安装或升级 astria，也不运行任何包管理器：部署方自行安装 CLI，图的构建是工具操作（`build`/`update`）或自动进行（默认启用的 `autoUpdate`、缺失图回退）。

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

请单独安装 astria（`npm install -g @nodesify/astria`）；提供方在每次加载时解析可执行文件，因此升级后重启 harness 即可启用新版本，可执行文件缺失会响亮地拒绝激活。本插件不集成 `astria install`，也从不改写 CLI 的配置：组合始终发生在 harness 一侧（补丁层、[示例 overlay](../../../apps/cli/config/examples/codegraph-astria/astria.cordis.yml)）。

### 最小配置

无需任何配置：默认在清洗后的 PATH 上解析并运行 `astria`，并在 agent 编辑后自动保持图最新（`autoUpdate`）。

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
| `transport` | `cli` | `cli` 每次查询运行一个 astria 子进程；`server` 为每个工作区根目录保有一个池化的 `astria mcp` stdio 子进程并通过它回答查询（刷新始终一次性运行） |
| `serverTimeoutMs` | `30000` | `server` 传输的 MCP 握手与单次调用预算 |
| `editContext.enabled` | `false` | 被观察的编辑成功后，查询其影响范围（对被编辑路径运行 `astria affected`）并作为有界模型上下文附加 |
| `editContext.tools` | `write`、`edit`、`str_replace_editor` | 视为编辑（用于附加上下文）的工具名称 |
| `editContext.maxChars` | `2000` | 附加影响范围上下文的最大字符数 |
| `orientation.enabled` | `false` | `compaction/end` 事件后，为会话 agent 注入一份令牌预算内的仓库图作为下一次模型可见上下文 |
| `orientation.budgetTokens` | `1000` | 注入的仓库图令牌预算 |
| `autoUpdate.enabled` | `true` | 文件修改类工具成功后，启动一个由编辑 agent 拥有的防抖后台 `astria update` 任务，并在刷新完成的图落地时注入通知；需要组合任务注册表与工具运行时 |
| `autoUpdate.debounceMs` | `3000` | 最后一次编辑之后、刷新任务启动之前的静默窗口 |
| `autoUpdate.tools` | `write`、`edit`、`str_replace_editor` | 视为编辑的工具名称 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-astria)是每个可接受字段的详尽来源。

### 一次查询做什么

每个查询映射为一个 astria 子命令（`map`、`query`、`explain`、`path`、`affected`、`stats`），`--graph <root>` 固定工作区；细化字段变成 `--depth`、`--directed`、`--cursor` 与 `--budget` 标志。缺失的图以结构化 `CODEGRAPH_NO_GRAPH` 失败（匹配 astria 稳定的 "No graph found" stderr 行），工具会把它转化为一次自动后台构建。子进程运行一次并收集 stdout/stderr；退出码 0 返回报告文本及其截断事实，任何其他退出都作为结构化 `CODEGRAPH_EXIT` 错误失败，其消息携带有界的 stderr 尾部 — 因此缺失的图以 CLI 自身的指引呈现，而不是无声的空结果。取消与插件释放通过子进程接缝的托管范围终止子进程。

### 附加提示

两个可选监听器把图的能力延伸到显式调用之外。`editContext` 在每个被观察编辑的结果上附加该编辑的影响范围（对被编辑路径运行 `astria affected`）作为有界上下文。`orientation` 监听 `compaction/end` 会话事件，并为压缩后会话注入一份令牌预算内的仓库图作为下一次模型可见上下文；二者在没有活跃 agent 或图时保持静默。

### 刷新与自动更新

`refresh` 以同样的一次性纪律运行 `astria run`（完整流水线）或 `astria update`（增量 AST-only 重建）；放置由调用方决定 — `code_graph` 工具通过 `ctx.jobs` 以本包的 `codegraph` 任务种类把构建调度为后台任务。`autoUpdate` 默认启用：`tools/post-execute` 监听器观察配置的文件修改类工具，在编辑落定后为每个工作区启动一个防抖的、由 agent 拥有的后台更新，并注入下一次请求可见的 `astria` 来源通知。该监听器只在组合了任务注册表与工具运行时时激活。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

### 设计要点

- **两种查询传输。** `cli` 每次查询运行一个完整子进程：没有进程池也没有协议状态，因此一次崩溃只影响它那次查询。`server` 为每个工作区根目录池化一个 `astria mcp` stdio 子进程（在子进程接缝的管道流上运行换行分隔的 JSON-RPC，`lsp-stdio` 形态）：死亡或超时的子进程在失败到达调用方之前被替换一次。刷新始终一次性运行 — MCP 服务器不提供构建工具。
- **加载时版本诊断。** 激活时派生一次 `astria --version` 并记录该行；失败的探测只警告，从不阻断启动。
- **执行世界配对。** 可执行文件通过 `ctx.subprocess` 解析和运行，因此把子进程提供方指向远程世界时，图查询随之迁移。
- **有界收集与诚实的截断。** stdout 以 `maxOutputBytes` 收集并保留尾部；结果的 `truncated` 标志即收集读取器的 `lossy` 事实，因此消费者不会把尾部报告误当作完整报告。
- **先归类中止再归类退出。** 被终止的子进程以信号退出事实结算 `done`；提供方先检查融合信号，因此调用方取消或释放以中止原因呈现，绝不会伪装成 astria 失败。

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、加载时可执行文件解析、单提供方注册 |
| [`src/args.ts`](src/args.ts) | 纯粹的接缝请求 → astria argv 映射 |
| [`src/provider.ts`](src/provider.ts) | 一次性查询与刷新运行器：派生、收集、退出归类、释放静默 |
| [`src/server.ts`](src/server.ts) | 池化 MCP 子进程：握手、按 id 关联的调用、到期退役、拆除 |
| [`src/server-provider.ts`](src/server-provider.ts) | 传输选择：查询走服务器，刷新与释放走 CLI |

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

- **CLI 传输上每次查询一次进程派生** — 每次查询（以及两种传输上的每次刷新）都付出 CLI 启动（包括打开 SQLite）；延迟敏感的部署改用 `transport: server`，它为每个工作区根目录池化一个子进程，并在失败到达调用方之前替换一次死亡或超时的子进程。
- **面向人类的 CLI 输出** — astria v1 没有机器可读的输出标志，因此结果是 CLI 按令牌预算生成的文本原样；上游提供 `--json` 表面后，接缝才能生长出结构化结果分支。
- **没有约束策略** — 本包信任配置的可执行文件，不添加沙箱；受限部署必须提供合适的子进程提供方或同世界沙箱包装。
- **缺失图的匹配基于 stderr 行** — `CODEGRAPH_NO_GRAPH` 依赖 astria 的 "No graph found" 消息文本，上游措辞变化只会使其退化为普通 `CODEGRAPH_EXIT`（模型仍能看到 CLI 指引），不会造成破坏。
- **附加提示尽力而为** — 影响范围与方向恢复监听器在没有图、agent（或对方向恢复而言没有活跃 agent）时静默跳过；它们绝不会让工具调用失败。
- **自动更新只观察工具介导的编辑** — 监听器只对配置的工具名称（默认 `write`、`edit`、`str_replace_editor`）作出反应；shell 驱动的文件变更只有通过模型下一次显式刷新才会进入图。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文 — 点击展开</summary>

本开发备忘是面向维护者的工作上下文：尚未决定的开放设计问题与方向。它明确不具权威性 — 已交付的行为、限制与接受的依据保存在上方章节、包代码与链接的 Agent Note 中。

- astria 发布节奏很快；本提供方只依赖六个已文档化的子命令与标志，上游的破坏性变更会以携带 CLI 自身消息的 `CODEGRAPH_EXIT` 呈现，而不是无声的错误行为。
- 集成所依赖的上游表面刻意很窄：六个子命令及其标志、"No graph found" stderr 行，以及（server 传输）MCP 工具 schema。能让集成更进一步的上游增强 — 面向结构化结果的机器可读输出（`--json`）、`god_nodes`/`list_communities`/`get_neighbors` 的 CLI 对等、面向真正新鲜度探针的图构建元数据 — 是期望而非前提；没有任何一项阻塞今天的交付。为 dsh 提供 `astria install` 平台目标的方案经权衡后放弃：组合属于 harness 自身的分层。

</details>
