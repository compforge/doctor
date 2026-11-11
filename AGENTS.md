# AGENTS.md

## 项目定位与边界

Doctor 是以本地 `doctor` CLI 为中心的开源业务诊断工具。在产品心智上，它是面向业务的增强版
`kubectl`：`kubectl` 以 Kubernetes Resource/Object 为操作对象，Doctor 以业务 Service 为基本诊断
粒度；Service 显式拥有零到多个 Workload，Pod、Container 与 Process 是 Workload 的运行实例和证据来源。
业务 Service 与 Kubernetes Service 是不同概念，后者只是一种 Workload discovery。Service 通过
Inspect/Probe/Detector contribution 声明确定性诊断工作，通过 capability 声明可复用业务能力，以及运行
它们所需的目标数据和 access。CLI 负责确定性采集、证据编排、
报告交付和本地 agent 问答。业务知识和私有 Service 访问规则不进入本仓，通过 Plugin 协议由使用方
独立实现和分发。

本仓包含通用 CLI、可复用 Agent、Plugin SDK、业务中立的示例 Plugin，以及可选 Doctor server 的宿主
边界；不包含任何企业内部 server、业务 Plugin、Skill、环境配置或私有部署信息。

## 诊断能力模型

产品主线是：部署后、承接业务前用 Health 主动巡检；运行一段时间后用 Overview 回顾情况；
发现问题后用 Collect 汇集证据，并按信息类型进入具体命令。

Doctor 的诊断范围从通用信号逐步深入到业务语义：先覆盖 Trace、Metric、Log 三类可观测性信号，再
观察 CPU、内存、网络等运行时状态；业务侧通过 contribution 补充 data、config 等领域采集与判断，
通过 capability 提供 store、model、case 等可复用能力，
必要时以受控 HTTP 或协议调用主动复现问题。Eval 按 canonical CaseSet 逐例触发请求并采集关联证据，
但不在 Doctor 内评价回答质量；只在压力下出现的问题归 Perf 施压与同窗口信号关联。Model、MCP 等
业务特有领域仍复用同一套 Service 与 capability 模型。

`image`、`debug`、`install`、`resize` 属于 Provision，负责显式准备镜像、临时环境和工具，以及调整当前实例的资源限制。确定性问题由 Core 的
通用能力与 Plugin 的业务 capability 协作形成 Evidence 和报告；无法预先固化路径的开放式问题交给
Doctor Chat，由通用 Agent runtime 使用当前 Plugin 随版本交付的 Skill。

## 排查主线

Doctor 围绕系统运行过程提供三个入口，组成从主动巡检、运行回顾到问题取证的一套排查工具：

| 时机 | 入口 | 要回答的问题 | 结果 |
|---|---|---|---|
| 部署后、开始承接业务前 | [Health](cli/docs/commands/health.md) | 服务自身是否健康，能否访问依赖并完成基本功能？ | 本次 Probe 与 Case 的检查结果、发现的问题和覆盖缺口 |
| 系统运行一段时间后 | [Overview](cli/docs/commands/overview.md) | 这段时间运行得怎么样，出现了哪些错误或慢请求？ | 窗口内的统计分布，以及按需查询的代表业务 ID |
| 发现具体问题后 | [Collect](cli/docs/commands/collect.md) | 需要哪些现场信息来解释问题？ | 多个数据面的原始证据、分析结果和可离线阅读的报告 |

Health 主动执行 `self / deps / biz` 检查。典型时机是部署验证，也可在配置变更后或运行中重新检查；
结论对应本次实际覆盖的服务、依赖和功能。Overview 查询已经发生的运行记录，保留时间窗口、统计口径和
数据覆盖范围；支持采样的条目可以取得代表 biz-id，再经确认进入 Collect。

Collect 汇集解释问题所需的信息，各具体命令按信息类型拥有查询、采集和分析能力。集合命令当前组合
Inspect、Tenant、Data、Trace、Log 和 Metric；这些命令也能单独运行。其它专项工具按问题需要显式调用：

| 所需信息 | 具体命令 |
|---|---|
| Service 运行状态、配置与资源 | `inspect`、`compute`、`resource` |
| 租户与业务对象记录 | `tenant`、`data` |
| 请求链路、日志与指标 | `trace`、`log`、`metric` |
| 存储状态与具体数据库记录、对象 | `store`、`db`、`s3` |
| CPU、内存与网络现场 | `cpu`、`mem`、`net`；`mema`、`neta` 分析离线产物 |

这是一条可按需要进入、深入和复查的路径。已知失败请求的 biz-id 时可以直接 Collect；已知要查日志时
可以直接 Log；Health 发现配置或依赖问题时也可以直接 Inspect。修复后再运行相关 Health 检查，并在后续
Overview 中观察实际业务表现。读取结果时结合原始证据、采集完整度和 Finding，查询失败或没有覆盖不能当作正常。

## 代码地图与核心模块

| 目录 | 角色 |
|---|---|
| `cli/` | Doctor CLI：命令入口、诊断编排、通用 infra、Evidence 与报告 |
| `toolkit/` | 独立版本的诊断工具、debug image 与离线系统包；按执行位置的 OS/arch 分发 |
| `server/` | 可选 Doctor server 的宿主边界 |
| `packages/agent/` | `@compforge/doctor-agent`：供 CLI 与 server 宿主共用的 agent loop、Skill 输入和 AgentUE 输出 |
| `packages/plugin/` | `@compforge/doctor-plugin`：Plugin、Service Catalog、contribution 与 capability 公共协议 |
| `plugins/example/` | 只演示协议接入的业务中立 Plugin |

Core 与 Plugin 共用的基础设施由 Quality Harness 的 `@compforge/harness-toolbox` 提供；根目录 `toolkit/` 仍负责诊断资源分发。

更细的 CLI 分层与诊断领域索引见 `cli/AGENTS.md`。

## 关键约定

1. **Core/Plugin 共用一条 Collect 流程**：Core 通过 Service contribution 统一驱动
   Inspect → Probe → Detector，通过 capability 复用 DataSource、Model、Case 等业务能力；access、类型化 data、
   Target-scoped infra 与 profile config 只支撑 contribution/capability 的准备和调用，不形成平行生命周期。
   私有业务实现不进入 CLI/SDK。
2. **Plugin 是产品的装配与分发形式**：Plugin 通常对应一个以 Service 为组成单位的 Product，
   统一交付产品知识、多个 Service 及排障 Skill；Service
   是 contribution、capability 和所需 access 的声明单元，Plugin 不重建 Core 访问层；`plugin@version` 的代码
   与 Skills 内容不可变，任一内容变化都必须提升 Plugin version。
   Resource 通过 Service.resources 贡献 Common 资源声明与原生 observe 操作，kind 是 Plugin 定义的开放类别；只读盘点归 resource 命令。
   Case 与 DataSource、Workload 一样由 Service 贡献；共享定义和运行时对象准备归 Case 来源，Health、Perf、Eval 各自拥有消费流程。
   Case 的 producer、runner factory 是资源自身的原生能力，不通过 Extension 注册或适配；只共享 access、上下文与调用信封。
3. **确定性诊断以 Evidence 为结果**：Fact 表示本次诊断内足够稳定、可供后续 Probe 复用的信息，
   Observation 只表示某个探测时间点或时间窗口取得的信息；这种稳定性是相对生命周期，不是永恒真理。
   采集阶段允许受控的临时准备，Detector 与 Render 只消费已取得的 Facts/Observations，不继续访问外部资源。
4. **默认安全边界显式化**：命令先完成配置、capability、环境与实际 access 准备，再进入领域工作；
   外部访问应声明超时、容量与权限，有副作用的操作必须在执行前展示并确认。
5. **Agent 共用，宿主分离**：CLI 与 server 通过各自的 interface、凭据和执行环境使用同一
   `packages/agent`；Skill 跟随 Doctor Host 当前加载的精确 Plugin 版本，不建立独立安装、选择或升级生命周期。
6. **Core 内容与版本同步演进**：Doctor Core 的代码或非 Markdown 用户可见内容发生变化时，必须在同一
   PR 运行 `make -C cli bump-version` 提升 patch version；纯 Markdown 文档改动无需提升版本。
   `cli/src/app/version.ts` 是唯一版本事实源，运行时、构建产物命名与 Release 都读取该值，不在其它
   文件重复维护版本号。
7. **Toolkit 独立演进**：工具、debug image、离线系统包与兼容性 manifest 归 `toolkit/`，不进入 CLI
   executable；任一交付内容变化都必须提升 `toolkit/VERSION`。平台按资源实际执行位置解析，不能用
   Doctor Host 平台替代 Kubernetes Target 平台。
8. **Spec mark 与 Specgen 分离**：`@spec` 等 mark 是随代码维护的观念/设计意图结构化注释，按设计需要
   正常新增或修改；这不意味着必须更新索引。`specgen` / `specgen:check` 及 `spec.json` 生成只在维护者
   明确要求时执行，agent 不因普通代码、文档或 mark 变更主动触发。

## 全局配置优先级

所有 Command 对同一配置项统一遵循 **CLI 显式参数 > 当前 profile 配置 > 默认值**。
CLI 显式参数代表用户本次调用最实时的诉求；profile 保存可复用的运行配置；默认值补齐两者都未指定的项。
高优先级值覆盖低优先级值是正常选择，不作为配置冲突拒绝执行，也不修改持久化的 profile。

- 按配置项确定有效值；未提供某个 CLI 参数时，仍可使用该项的 profile 配置。
- 保留“显式提供”与“自动填入默认值”的区别。Commander 或 Distribution 提供的默认值属于默认层，
  不能因为已经出现在解析结果里就覆盖 profile。是否提供参数不能用 truthiness 判断；合法的 `false`
  或 `0` 也表达用户意图，空值是否合法由该参数的契约决定。
- 优先级只决定取值来源，不是失败重试顺序。选定值无效、目标不可达或执行失败时，应报告对应错误，
  不自动尝试低优先级的配置。配置结构校验、参数约束与权限校验仍须执行。

例如，显式 `--kubeconfig` 覆盖 profile 中的 kubeconfig；该文件不存在或解析失败时直接报错，
不能改用 profile 或默认集群。只有上层未指定时，才进入该参数已有的默认查找规则。
这条约定适用于所有配置项，不限于 Kubernetes；不要求每个 CLI 参数都新增对应的 profile 字段。


宿主或 Skill 将业务环境名解析为通用参数后交给 Doctor；Core 不解释具体产品的环境名。
目标展示和后续访问使用同一份有效配置，并保留来源。具体解析与 Environment 身份见
[配置与目标](cli/docs/configuration.md)。

## 文档归属

`AGENTS.md` 直接维护开发所需的核心模型、主流程、职责地图与全局约束；子目录的 `AGENTS.md`
补充该模块的边界。具体机制和设计理由由对应的 `docs/<topic>.md` 维护，已有主题直接更新，
其它文档只保留必要摘要和链接。`README.md` 面向使用和接入。

## References

- `cli/AGENTS.md` — CLI 定位、分层与诊断能力地图
- [Command 生命周期](cli/docs/command-lifecycle.md) — 命令准备、调用作用域、幂等复用与取消
- [Collect 协议](cli/docs/collect-protocol.md) — 采集数据模型、调度、授权与执行状态
- [配置与目标](cli/docs/configuration.md) — 参数来源、Environment 身份与宿主目标传递
- `cli/docs/plugin.md` — Plugin capability、上下文、分发与信任边界
- `cli/docs/commands/eval.md` — Eval 数据集触发、关联证据采集与质量评估边界
- `docs/chat.md` — Doctor Chat 数据流、Agent 复用边界与 Plugin Skill 生命周期
