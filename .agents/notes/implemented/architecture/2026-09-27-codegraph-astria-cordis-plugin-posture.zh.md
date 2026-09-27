# Agent Note: codegraph astria 家族是一个可组合的 Cordis 插件接缝

Status: implemented

[English](2026-09-27-codegraph-astria-cordis-plugin-posture.md) | 中文

## Problem

astria 代码图集成本可以做成 harness 的内置流程——在 agent 循环里硬编码一个工具，在每个随附 bundle 里挂载一个提供方。作者并不拥有 dsh，并打算把该集成作为独立发布的插件对外提供，因此结构必须让提取变得机械：遵循 Cordis 插件约定、以 effect 方式注册、以及按需组合。仅凭代码无法说明 dsh 宿主插件与通用 Cordis 插件之间的边界，也无法说明该插件在激活期间为何保留一个 Cordis 内部事件。

## Decision

该家族按 dsh-lsp 三包模式做接缝拆分：

- `dsh-codegraph` —— 服务定义：一个 `Service` 子类，以 `ctx.codeGraph` 合并到 `Context`；唯一提供方注册表，其注册通过返回 disposer 的 `ctx.effect()` 完成；封闭的十操作联合；`CodeGraphError` 错误分类；以及品牌化的提供方 id。不包含任何提供方或工具逻辑。
- `dsh-astria` —— 提供方插件：按 Cordis 规范提供 `name`/`inject`/`Config`/`apply`；在加载时急切解析 astria 可执行文件（可执行文件缺失会响亮地拒绝激活）；通过 effect 注册唯一提供方，其 disposer 先注销再拆除子进程。`autoUpdate`（默认开启）、`editContext` 与 `orientation` 都通过 `ctx.inject` 的可选服务门控，在缺少作业注册表、工具运行时、会话或 agent 时保持静默。
- `dsh-tool-codegraph` —— 消费者：`defineTool`，按操作做参数校验，token 预算由结果字符上限推导，通过 `ctx.jobs` 以本家族 `codegraph` 作业类型在后台构建。
- `dsh-skill-codegraph` —— 在 `ctx.skills` 上注册的内置导航技能。
- `dsh-client-ui-codegraph` —— 会话行（宿主 `apply` 为空操作；浏览器半边经 `dsh.client` 发布）。

组合是按需的。没有任何 dsh bundle 或 profile 挂载这五个包中的任何一个；codegraph UI 行已从 `web-app` bundle 及其清单中移除，因为它属于 astria 家族，[示例 overlay](../../../../apps/cli/config/examples/codegraph-astria/astria.cordis.yml) 现在组合全部五个包。astria 包不是内置流程：它们是恰好生活在本仓库中的第三方形态插件。

每个包都是真正的 Cordis 插件；「dsh 宿主插件」与「通用 Cordis 插件」的区别在于注入的服务词汇表，而不是 Cordis 合规性。dsh 宿主插件注入 dsh 所属的服务（`subprocess`、`jobs`、`tools`、`agents`、`sessions`、`llm`），扩展 dsh 所属的类型映射（`JobKindMap`、`MessageSourceMap`），因此需要一个能提供 dsh 服务集的宿主。通用 Cordis 插件只依赖 Cordis 核心与自身发布的服务，可在任何 Cordis 宿主上运行。与 dsh 宿主耦合并不会阻碍插件市场收录——清单中的 `inject` 与 `peerDependencies` 就是市场所服务的契约——但它确实把可移植性限定在提供 dsh 服务的宿主上。

激活保持急切且失败响亮。插件通过 Cordis 声明的内置 `internal/plugin` 事件（某 fiber 的 uid 已被清除）观察自身的卸载并中止挂起的可执行文件解析，因为 Cordis 只在异步 `apply` 回调返回后才运行 effect 清理，且不存在公开的销毁事件。这与仓库中对该事件的既有用法一致，并非协议逃逸。

## Recorded sessions

注入的 astria 通知与定向地图是带 `astria` 来源种类的模型可见 user 消息，这是一次同版本持久化新增，已在 [astria-source 持久化变更](../../../../docs/persistence-changes/2026-09-27-codegraph-astria-source.zh.md)中确认；早于该种类出现的读取方按契约对未知消息来源放行。

## Alternatives considered

**把 astria 接入 agent 循环并放进默认 bundle。** 已拒绝：它会把作者并不拥有的能力耦合进 dsh 的发布面，违背以 effect 注册的规则，并放弃插件市场意图。UI 行曾短暂进入 `web-app` bundle，出于同一原因被移除。

**改为惰性解析可执行文件以去掉 `internal/plugin` 观察者。** 已拒绝：它用文档化的「加载时缺失可执行文件即拒绝激活」契约换来按查询出现的意外，而且 `internal/plugin` 是 dsh 核心已在使用的 Cordis 声明内置事件，并非可移植性障碍。

**把提供方做成带自有服务词汇表的通用 Cordis 插件。** 已推迟：这意味着要在 dsh 之外自行拥有接缝、子进程抽象与消息来源模型；接缝拆分已经把这几条边界全部隔离出来，提取时再决定目标形态也不会有返工。

## Consequences

- 该家族可以机械地搬出本仓库：接缝拆分、effect 作用域生命周期与注入服务都是现成的。要在其他 scope 下发布，仍需重新发布其所注入的 dsh 服务对等包（十个包），或改为通用形态。
- 默认 dsh bundle 不携带任何 astria 表面；部署通过示例 overlay（提供方、工具、技能与 UI 行）启用整个家族。
- 会话日志可能携带 `astria` 来源的消息归因；持久化 schema 记录了该确认。
- 任何未来的独立收录都必须说明宿主服务要求；README 安装契约已经这样做了。