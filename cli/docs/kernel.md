# CLI Kernel

## 理念 / 概念

Doctor CLI 的 Kernel 定义跨 Command 稳定的生命周期、数据流、扩展边界和信任边界。Provision、Collect、
Eval、Perf 与 Chat 共用启动上下文和基础设施，但各自拥有不同的领域结果：

| 主路径 | 主要结果 | 与 Collect 的关系 |
|---|---|---|
| Provision | 外部能力或环境准备完成 | 不隐藏在 Collect 中；由用户显式触发 |
| Collect | 可复查的 Evidence、Finding、Coverage 与诊断产物 | 确定性诊断主路径 |
| Eval | Case 执行记录及关联证据 | 复用已有 Collect 入口采集证据 |
| Perf | 受控负载结果及同窗口证据 | 复用已有 Collect 入口采集证据 |
| Chat | Agent 会话与 AgentUE 输出 | 面向无法预先固化路径的开放式问题 |

Collect Command 的最小模型是：**Core 统一驱动 Prepare、Execute、Finalize；Execute 固定沿
Inspect → Probe → Detector 推进；Core 与 Plugin Service 在同一流程中贡献能力，不形成两套执行框架。**

## Collect Command Kernel

CLI composition root 接收可选的 `Distribution`，再构造完整 Commander 命令目录，通过
`addCommand` 装配入口。发行配置拥有名称、描述与命令展示，Plugin 继续独立拥有业务能力。
发行配置的 `commands` 或构建参数 `DOCTOR_COMMANDS` 只决定顶层命令的 `hidden` 标记；显式发行配置
优先，帮助与版本始终可见，未指定时全部可见。发行装配与身份边界见 [发行版](distribution.md)。
该选择固化在发行物中，独立于 Plugin capability 与环境可用性。隐藏不限制直接调用，也不改变
组合命令内部的执行能力；它是帮助展示策略，不是权限或代码裁剪边界。

Kubernetes 连接参数在根命令统一声明，通过 Commander 全局选项传入 CommandContext；子命令不重复
声明，不借进程环境变量传播目标。参数解析和 Help 构造不触发环境访问。

### 全局配置优先级

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

CLI adapter 保留 Commander 参数来源，在共享 Command 准备入口消除被 profile 覆盖的默认值；
领域 resolver 仍负责字段校验与来源记录。新增 profile-backed 参数时，应同步更新入口的字段映射。
Chat 校验、Skill 目标注入和远端 kubeconfig 上传使用本次调用的有效目标，不直接复用原始 profile。
本地 Skill 可读取 `TARGET_KUBE_CONTEXT` 并作为 `--context` 传给 Doctor/kubectl。
远端 Chat 协议不携带 context，因此显式 `--context` 会报错；可传入已设置 `current-context` 的 kubeconfig。

宿主或 Skill 将业务环境名解析为通用参数后交给 Doctor；Core 负责应用同一优先级与校验规则，
不解释 AS 等产品的环境名。目标选择与后续访问应使用同一份有效配置，目标展示应能说明实际值及来源，
便于使用者确认本次访问对象。

### Environment 与配置来源

先按 `CLI kubeconfig > profile kubeconfig > 默认 kubeconfig` 选定访问配置，再用显式 context 或
该配置的 current-context 确定 Environment。profile 是配置来源，不是环境身份；不同 profile 指向
相同 cluster/context 时可得到同一环境身份，同一 profile 被 CLI 覆盖到其它集群时必须得到不同身份。
无效的高优先级配置直接失败，不尝试其它集群。

Core 只从选定配置读取 context 与 cluster endpoint，生成不含凭据的身份，并固定本轮使用的 context。
Command 的 EnvironmentContext 借用根 ClientManager；Service 绑定、WorkloadInstance 证据与 Plugin
客户端作用域使用这个身份。namespace 是环境内的访问范围，不作为 profile 名的替身。

### 三阶段生命周期

```text
Prepare
  → 解析 Config / Profile / Target / Service
  → 选择 Core 与 Plugin Service contributions
  → 形成 access plan 与 CommandContext
  ↓
Execute（Core 驱动）
  → Inspect [Core Inspect + Plugin Service Inspect]
  → 汇总并冻结 Facts
  → Probe(Facts) [Core Probe + Plugin Service Probe]
  → 汇总 Observations，构建 Evidence
  → Detector(Evidence) [Core Detector + Plugin Service Detector]
  → Findings / Coverage / Diagnosis
  ↓
Finalize
  → 释放共享 Client
  → 根 CommandSpec.serialize（本地持久化 / 显式子执行引用）
  → 按格式触发 CommandSpec.render（本地领域页面 / 子报告组合）
  → Report / Artifact / Bundle
  → Delivery / Cleanup / exit status
```

Inspect 与 Probe 之间存在阶段屏障：选中的 Inspect 全部收敛并冻结 Facts 后，Core 才生成 Probe 计划。
Detector 只能在 Observations 汇总成 Evidence 后运行。Plugin Service 只注册 contribution；阶段推进、
调度、失败隔离和收尾始终由 Core 控制。

### Command 的准备扩展点

`defineCommand` 是独立命令和聚合子命令共用的调用入口。输入校验、Plugin 能力存在性检查和环境准备
完成后，调用可选的 `CommandSpec.prepare`，再把其类型化结果传给领域 `run`。无需额外准备的命令直接
消费输入；调用者始终传入原始 Input，不自行调用 prepare 或构造准备结果。

prepare 根据本次输入选择并绑定资源和能力，Service 则提供 Workload、DataSource、capability 与 access
声明及实现。Service 不接收 Command DTO，也不根据命令名切换业务行为。内置工作和 Service contribution
通过相同的执行契约进入系列引擎；Plugin 适配层保留来源、受限上下文与结果校验。

准备结果属于命令内部，可以包含运行时 handle，不要求可序列化。prepare 与 run 处于同一个调用资源
作用域和幂等复用单元：准备失败时保留已登记产物并释放局部资源；prepare 返回 undefined 表示取消，
中止本轮且不进入 run。共享客户端仍由根 Finalize 回收。准备期间的外部访问同样必须先检查 access；
需要作为 Evidence 留存的现场获取结果继续通过 Inspect 等取证流程处理。

Execute 的内部流程由命令系列决定；Collect 使用 Inspect → Probe → Detector，Provision 等系列保留
自身领域流程。Finalize 统一消费 CommandResult，通过 serialize/render 完成本地持久化与交付。

### Core 与 Plugin Service 分工

| 阶段 | Core | Plugin Service |
|---|---|---|
| Prepare | 解析并校验用户意图；选择 Target、Service 与 contribution；合并 Core/Plugin access needs；创建本轮上下文和清理责任 | 声明 Service、Workload、capability、dependency、access 与 contribution；校验 Plugin-owned config；不自行创建命令生命周期 |
| Inspect | 形成 Query；决定 Inspect 的依赖、顺序、预算、遍历、去重和失败隔离；驱动 Core/Plugin Inspect；规范化并冻结 Facts | 执行一批业务 Inspect Query，逐项返回结果与 Fact/Relation；拥有私有协议和业务数据语义，不拥有遍历或后续调度 |
| Probe | 根据冻结 Facts 生成计划；向 Probe 注入公共 Fact；控制依赖、策略、授权、风险和资源生命周期；驱动 Core/Plugin Probe | 执行一次业务 Probe，消费 Input/Facts 并返回 Observation；不内建循环、并发或跨 Probe 调度 |
| Detector | 构建 Evidence；统一执行 Core/Plugin Detector；校验证据引用与 provenance；形成 Coverage 和 Diagnosis | 提供纯业务 Detector，消费只读 Evidence，返回带显式证据引用的 Finding；不接收运行上下文或发起 I/O |
| Finalize | 释放 Client，序列化结果，按需驱动 Renderer，完成 Delivery、Cleanup 与最终退出语义 | 不拥有阶段或资源生命周期；业务语义已通过 Fact、Observation 与 Finding 进入 Diagnosis |

Plugin 不必在每个阶段都有可执行逻辑。Prepare 中它主要提供声明，Execute 中贡献业务采集和判断，
Finalize 则由 Core 收口。Renderer 的领域逻辑归 Command 所属模块，通过 `CommandSpec.render` 在根 Finalize 中驱动；只消费本地结果与证据。

## Execute 数据模型

### Inspect 与 Fact

Inspect 回答“本轮诊断中已经知道什么”。Core Command 根据诊断目标形成由 `Identity + Constraints`
组成的 Query，并选择 Core Inspect 或接受该 Identity 的 Service Inspect contribution：

```text
Query(Identity + Constraints)
  → Inspect
  → InspectQueryResult
  → ValueFact / RecordFact / RelationFact
```

- `ValueFact` 表达一个 kind 至多一个的领域值。
- `RecordFact` 表达同 kind 可重复、带稳定 `recordKey` 的独立记录。
- `RelationFact` 表达两个 Identity 之间已经由现场数据证明的关系。

Fact 在一次 Command 内足够稳定，可被后续 Probe 和 Detector 复用，但不是跨时间永远成立的真理。
InspectQueryResult 独立表达解析状态、缺失证据与截断，不能把采集状态伪装成领域 Fact。
Core 与适配后的 Plugin Fact 都携带 `kind + schemaVersion + producer`。`runInspects` 在阶段边界校验
每个叶子 Fact 的 schema identity，并要求 Core Fact 的 `producer.id` 等于实际执行的 `Inspect.id`；违反
契约属于实现错误，不能降级成 Coverage 缺口。Fact 不另设对象 ID，Detector 通过本轮 Evidence 中的
`factPath` 引用它。

RelationFact 可以形成后续 Query，但只有 Core Command 能决定是否继续，以及查询深度、容量、去重、
失败隔离和停止条件。Plugin 拥有 Identity、Fact、Relation 的业务语义与固定查询，不拥有自递归调度。

### Probe 与 Observation

Probe 回答“针对已确认目标，本次主动观察到了什么”。Core 根据冻结 Facts 选择并驱动 Core Probe 与
Service Probe。领域先显式选择可公开的 Fact、Service scope、`factPath` 与 value shape，再由共享
Service Evidence adapter 保留原始 `kind + schemaVersion + producer` 并形成公共投影；adapter 不递归遍历
Evidence，也不把 Fact payload 的子对象派生成新的伪 Fact。当前选出的公共 Fact 不再按 Service、producer
或 kind 过滤；所有 Probe 共享同一份深冻结快照，只能消费，不能修改或追加 Fact。

Probe 是一次执行原语：可以使用 Core 提供的 Target-scoped infra 和授权入口，但不拥有 Command 的循环、
并发、预算、停止条件或 Evidence。Observation 只陈述某个探测时间点或时间窗口看到的状态，不能默认
代表之后的现场。Probe 之间的真实数据依赖显式声明；会产生负担或改变现场的动作必须经过 Operation
授权。

Plugin Workload Probe 的 Observation 契约由 Plugin 以 `produces: ObservationDefinition` 拥有；其 TypeBox
object schema 同时驱动 TypeScript payload 推导和 Core 的 Draft 2020-12 运行时验证。Core 不信任
跨动态 ESM 边界的静态类型；未通过严格 JSON/schema 校验的 payload 不进入 Evidence，校验不会强转、
补默认值或删字段。

### Evidence、Detector 与 Diagnosis

Evidence 的持久化布局、清单与正文边界见 [Command 输出规范](command-output.md)。

Evidence 是本次诊断明确选择的 Facts 与 Observations。Detector 回答“已有证据说明什么”：

- Core Detector 提供跨业务通用判断。
- Service Detector 提供业务判断，可以关联跨 producer、跨 Service 的 Evidence。
- Detector 不接收 `CommandContext`、`PluginContext` 或 infra handle，不执行 I/O。
- Finding 必须显式引用 Evidence 中的 `factPath` 或 `observationId`。
- Core 通过同一个 Detector runner 执行 Core Detector 与适配后的 Service Detector，并校验 Finding 身份、
  producer、Evidence 引用和本轮唯一 ID；违反契约属于实现错误，不能降级成 Coverage 缺口。
- Coverage 表达诊断目标的证据充分度，不表达 Target 是否健康。

Fact、Observation 与 Finding 使用 `kind + schemaVersion` 标识 payload schema。Core kind 使用保留短名；
Plugin 本地 kind 由 Core 规范化为 `plugin/<plugin-id>/<service>/<local-kind>`。两者都携带结构化 producer，
消费方不能通过解析 kind 字符串猜测来源。Plugin version 标识实现版本，`schemaVersion` 只标识数据契约。
`cli/src/plugin/evidence.ts` 是 Core/Plugin Service Evidence 的统一适配边界：Core Fact/Observation 原样继承
已持久化 identity，Plugin 本地 schema 在这里统一补 namespace 与 producer；领域 projector 只拥有披露和
Service 关联决策，不能再次手写或改写 identity。

## 共享生命周期边界

### CommandSpec 与执行入口

每个常规命令提供 `CommandSpec<Input, Output>`，普通命令和组合命令共用
`run(context, input): Promise<CommandResult<Output>>`。CLI 将 flags 转为领域 Input；父命令直接调用
子命令的同一入口。`defineCommand` 包装校验、环境准备、取消与资源收尾，因此嵌套调用仍需满足自身
的 capability 和 access 前提。

根入口只解析一次 Profile，选定的 Plugin 及其配置校验在整轮内复用。每次调用按顺序执行：

```text
validate domain input
  → required Plugin capability + validated Plugin config
  → declared Host / Kubernetes environment
  → selected Target + staged access plan + permission check
  → domain work or child CommandSpec.run calls
  → invocation result + resource cleanup
```

组合命令逐个调用已选择的子命令；一个子命令不可用时，其它独立子命令仍可执行。子命令的必要条件
不能简单合并成父命令的全局门槛，否则缺少一种证据能力就会阻断整个概览或采集。

Input 可以提供 `idempotencyKey(): string`，显式声明本次逻辑执行的身份。`defineCommand` 在输入校验后，
按 Command 定义身份和 key 在当前 CommandContext 中合并调用：正在执行时等待同一个 Promise，包括资源
清理；已完成时返回原状态、Output、Artifacts 和 reportName，不产生 skipped 状态。未提供方法时每次独立
执行。完成结果包括 partial 和 failed，本轮不隐式重试；取消始终优先于复用。key 必须包含会改变结果的
领域参数，Profile、Plugin 和宿主配置由当前 Context 隔离，记录不跨 Doctor 运行保留。

Inspect 和 Tenant 的 Input 构造函数按检查范围、租户及采集参数生成 key，Collect 使用这些 Input 调用
子命令。调用方仍显式纳入子产物，Artifacts 按产物 ID 去重，因此多个 Collect 可引用同一份环境/租户证据，
最终报告只交付一份。Overview 无需识别第一次或后续 Collect。

### Context 与调用归属

`CommandContext` 属于整轮执行树，保存 Profile、当前 Plugin、按需准备并复用的环境信息、权限检查、
Decision、ExecutionRecord、共享 ClientManager 与取消信号。领域 Context 保存单次执行准备的 Target、client、
Bundle 和领域状态；PluginContext 只暴露本次 Service 调用所需的受限依赖与 infra。

同一 CommandContext 可以被并发子命令共享。Artifacts 使用异步调用作用域，每次调用返回自己的产物
引用和报告名称，父命令显式选择并纳入子产物；不能按全局列表位置或命令名猜测产物属于哪次调用。
领域输入与输出通过 Input / Output 传递，不放入共享 Context。

Artifact ID 标识一份具体产物，command 幂等 key 标识一次可复用执行，两者职责独立。CommandArtifacts
统一使用 add 登记或添加引用：首次登记由 Core 分配 ID，同一本轮内重复登记规范化源路径返回原引用；
已携带 ID 时保留身份，并校验其 command 与来源路径一致。父命令添加子结果不会重新分配 ID，幂等返回的
结果自然引用原产物。文件名和时间戳只用于阅读，不能承担产物唯一性。


Host 创建的 PluginContext 继承当前调用的取消信号，并登记到本次调用的资源作用域。显式 dispose
和执行层兜底清理共用一次回收；子调用只关闭自己的资源，不关闭父调用的资源。用户取消会传播到整轮
执行树，停止后续工作，并保留已生成证据。

共享基础设施由根 CommandContext 的 ClientManager 持有，命令通过只提供 get 的 `clients` 视图借用。
Service 的 `capabilities.dataSources` 是访问声明的唯一清单，store 只是消费它的诊断视角，
db 与业务 Inspect 不依赖 Store 命令。声明自描述保持离线，运行时 DataSource 不作为 Fact 持久化。
中立生命周期归 TypeScript harness-common；协议 Client 与 Transport 归 toolbox。

DataSource 标识目标与访问配置并构造 Client；Client.initialize 按需解析配置、选择 Transport、准备连接，
Client.dispose 幂等回收自己拥有的资源。构造函数不执行外部操作，查询及其结果仍属于各次领域调用。
普通领域数据保存在相应模块中，不进入通用 Context 缓存。

同一 DataSource 身份的并发调用等待同一次初始化；成功后复用 Client，失败后先清理部分初始化的资源，
再允许后续调用重试。身份包含影响访问的配置和凭据，不能使用对象地址。依赖客户端先获取，消费者后初始化；
finalize 等待所有初始化结束，再按相反顺序销毁，保证数据库先关闭、Kubernetes 通道后停止。
开始销毁后拒绝新获取，即使某个客户端清理失败也继续处理其余客户端。

Plugin 工厂接收独立的 PluginClientContext，其 signal 和受权限约束的 infra 属于根执行树，不能捕获
某次 capability 调用的上下文或 dependency handle。子调用只清理自己的临时资源。直接嵌入 CommandSpec 的
宿主同样负责在整棵调用树结束后调用根 Context 的 disposeClients；CLI 在 finalize 中统一完成此操作。


### 结果与 Finalize

CommandSpec 将 run、serialize 和 render 绑定到同一种领域 Output。run 取得数据与诊断结论；serialize
将完整 CommandResult 投影为本地文件和子执行引用；render 根据结果及已落盘证据生成阅读结构。
没有持久化结果或报告的命令可省略对应入口。聚合命令显式组合子执行及子报告，框架不猜测领域字段。

`CommandStatus` 统一定义 `ok / partial / failed / cancelled` 四种执行状态，描述命令完成度；业务错误、
Finding severity 和 Evidence Coverage 保留领域含义。根 CLI 映射退出码：ok/partial 为 0，failed 为非零，
cancelled 为 130。子命令不设置进程退出码，也不单独执行最终交付。

Finalize 只执行一次：先释放共享 Client，再调用根 serialize，按输出格式选择 render，最后交付整个目录。
SerializeContext 和 RenderContext 只允许本地操作，不能重新取得远端 Client 或执行采集。
同一 spec 的同一结果对象在本轮内共享序列化与渲染；独立结果即使内容相同也保留各自身份。
清理、序列化或渲染失败仍继续保留可用证据，阶段错误与原执行状态分别记录，取消优先返回 130。

SerializeContext 分配执行目录与清单引用。HTML 生成器消费显式 Report，按 Command section、业务对象和
页面引用组合离线 HTML；不按目录名猜测导航，不反解析子 HTML。Delivery 交付已序列化的目录及阅读文件，
不再重建调用关系。最外层决定报告名称与最终格式，路径、文件索引、失败保留和 JSON/Manifest 输出契约见
[Command 输出规范](command-output.md)，页面布局与导航见 [HTML 报告渲染](rendering.md)。

默认格式、partial 报告、Evidence Bundle、失败兜底和退出码语义由
[`collect-protocol.md`](collect-protocol.md) 统一定义。init/profile 等启动命令不要求已有 Profile。

## Core / Plugin 边界

Core 与 Plugin 使用同一套 Inspect、Probe、Detector 词汇。Service 是业务 contribution、Workload 和运行时
依赖的归属单元；Plugin 是多个 Service 与 Skill 的版本化分发单元。具体 Plugin 只依赖公共 Plugin SDK，
CLI Core 不依赖任何具体 Plugin 实现。

这里统一的是概念、执行阶段和 Evidence 语义，不要求 Core 与 Plugin 直接复用同一个代码 interface。
Core 实现可以直接消费进程内领域上下文；Plugin contribution 还必须携带 Service、版本、access 与分发
边界所需的信息。CLI composition root 负责把选中的 Plugin contribution 适配进同一 Execute 流程，不能
为了统一函数签名丢掉边界信息，也不让 `packages/plugin` 反向依赖 CLI Core。

双方边界分为两层：

| 边界 | 方向 | 所有权 |
|---|---|---|
| Inspect / Probe / Detector contribution | Plugin Service → Core | Plugin 提供业务逻辑；Core 选择、驱动并验证结果 |
| access | Plugin capability → Core | Plugin 声明最小需求；Core 合并、检查并授权 |
| dependencies | Service → Core | Service 声明所需其它 Service capability；Core 解析并注入受限 handle |
| data | Core ↔ Plugin capability | 公共包定义类型化输入输出；私有 schema 留在 Plugin 内 |
| infra | Core → PluginContext | Core 提供当前 Target 的受限访问、取消和资源生命周期 |
| config | Profile/Core → PluginContext | Core 不透明保存和透传；schema、校验和解释归 Plugin |

这些边界不能互相替代：取得 infra handle 不代表获得任意权限；config 不承载 kubeconfig 等 Core-owned
连接状态；业务返回值不能泄露整包私有配置；Plugin contribution 不能推进或绕过 Core 生命周期。

Kubernetes 只是 Doctor Host 到 Target 的一种访问通道。Core 解析 kubeconfig/context，托管查询、超时、
输出上限、取消和 port-forward 回收；Plugin 通过 Workload discovery 描述业务部署拓扑，通过 capability
持有专有 API 与业务语义。Plugin 不持有 kubeconfig，也不自行启动 kubectl。

## Collect 完成语义与安全

Collect 的命令终止、证据覆盖度、Target 健康和产物交付是不同维度：

- Finding severity 描述 Target 健康，不决定命令是否成功。
- Coverage 描述证据是否充分；partial 可以是正常完成状态。
- 单项 Probe 现场失败只降低对应 Coverage；Doctor 自身不变量错误不能伪装成 partial。
- Delivery 失败会改变最终命令结果，但不能抹掉已经取得的 Evidence。

Collect 以可审计 Evidence 为结果，即使某个 Probe 需要受控副作用，也不能隐藏式发布 image、创建 debug
environment 或安装工具。Operation 明确描述风险、目标、影响和步骤；授权只覆盖当前动作，不是 blanket
approval。完整的调度、Coverage、Worksheet、授权、报告和退出码契约见
[`collect-protocol.md`](collect-protocol.md)。

## 与其它主路径的边界

| 主路径 | 与 Collect 的稳定边界 |
|---|---|
| Provision | 以外部状态变化或能力准备为结果，不使用 Collect engine；只共享 CommandContext、终端和 infra |
| Eval | 顺序触发 canonical Case，并调用已有 Trace/Log/Data Collect 入口取得关联证据；不复制采集器，也不评价回答质量 |
| Perf | 负责并发、预算、熔断与性能窗口，并调用已有 Metric/Trace/Log Collect 入口；Plugin Case runner 每次只执行一个请求 |
| Chat | 使用共享 Agent runtime 处理开放式问题；不依赖 Collect 的确定性流程 |

Model discovery、Case、Trace、Store 等能力可以被多个主路径复用，但复用的是稳定 capability 或 Command
入口，不是复制内部编排。具体边界分别见 [`plugin.md`](plugin.md)、[`commands/eval.md`](commands/eval.md)、
[`commands/perf.md`](commands/perf.md) 与 [`../docs/chat.md`](../../docs/chat.md)。

## 依赖方向与代码地图

```text
cli/src/
├── app/                 Prepare / Execute / Finalize composition root
├── report/              Report、RenderContext、单文件阅读容器
├── command/             CommandContext、Target、access 与审批契约
├── collect/
│   ├── protocol.ts      Fact、Observation、Finding、Coverage 共享协议
│   ├── evidence-identity.ts  Fact/Observation/Finding schema identity 运行时校验
│   ├── engine.ts        runCollect：Inspect → Probe → Evidence → Detector / Coverage
│   ├── inspect-engine.ts  Inspect 依赖调度与 Facts 冻结
│   ├── probe-engine.ts  Probe 依赖、安全顺序与失败隔离
│   ├── detector-engine.ts  Core/Plugin Detector 执行与 Finding 契约校验
│   ├── evidence.ts      Worksheet 与 Evidence Bundle
│   ├── operation.ts     副作用授权与审计
│   ├── output/          通用格式与交付原语
│   └── <domain>/        领域 Config、Inspect、Probe、Detector、Renderer
├── provision/           image、debug environment 与工具准备
├── eval/                Case 顺序执行与关联证据编排
├── perf/                受控负载与跨数据面证据编排
├── chat/                Session / Controller 与 AgentUE adapter
├── plugin/              Plugin 宿主选择、加载与公共协议适配
├── model/               Model Collect 与 Chat 共用的模型访问
├── terminal/            选择、确认与输出边界
└── infra/               Host、Target、Kubernetes 与外部资源 adapter

packages/plugin/         Plugin、Service、capability 与 Inspect/Probe/Detector contribution 公共协议
packages/agent/          CLI/server 共用的 Agent runtime
plugins/<plugin>/        具体 Service 实现、固定查询与 Skills
toolkit/                 独立版本的诊断工具和平台资源
```

依赖方向保持：

```text
cli/collect → packages/plugin ← plugins/<plugin>
app → command / collect / provision / eval / perf / chat / infra
collect/<domain> → collect shared protocol + infra ports
```

公共协议和调度只有出现跨领域稳定、同语义的重复时才上提；领域数据语义、固定查询、Renderer 和具体
Failure/Coverage 解释继续留在 `collect/<domain>`。`packages/plugin` 不依赖 CLI，具体 Plugin 不反向依赖
CLI 实现。

## 深入阅读

- [`collect-protocol.md`](collect-protocol.md)：Collect 调度、partial、Coverage、授权、交付与退出码。
- [`plugin.md`](plugin.md)：Plugin capability、Context、分发和信任边界。
- [`extension.md`](extension.md)：面向各类 Command 的 Extension 协议、权限与调用边界。
- [`commands/collect.md`](commands/collect.md)：集合命令如何组合多个 Collect 入口。
- [`commands/tenant.md`](commands/tenant.md) 与
  [`commands/data-diagnosis.md`](commands/data-diagnosis.md)：Application 数据的 Query 作用域。
- [`commands/eval.md`](commands/eval.md) 与 [`commands/perf.md`](commands/perf.md)：Case 执行和主动负载。
- [`../../toolkit/README.md`](../../toolkit/README.md)：Toolkit 的独立版本与平台资源模型。
- [`commands/`](commands/)：各领域 Command 的理念、流程和关键设计。

新增 Collect Command 时，先定义 Facts、Observations、Evidence、Findings/Coverage 和纯 Detector，再实现
Inspect、Probe 与 Renderer；契约测试至少覆盖依赖调度、能力降级、授权拒绝、敏感信息边界和交付结果。

Pod 原始日志通过 Toolkit 的 PodLogDataSource/PodLogClient 访问。根执行注入共享网络并发与字节预算，
Client 管理快照和回放；Core Log 持有业务 ID、筛选与诊断。批量 Data 共用有界 Identity 遍历，按输入有向可达的
Query 结果分别运行 Detector；批量执行不合并各请求的业务结论，也不改变 Artifact 身份。

`runCollectBatch` 是共享采集引擎的列表入口：一次 Inspect 和 Facts checkpoint 完成后，再对各项
投影事实并执行 Probe → Detector。单项异常和排队取消有独立结果；并发调度只决定业务项何时推进，
实际外部访问仍受根 Context 的容量约束。投影继承原始事实身份，不通过回放 Inspect 制造另一轮采集。

### 单文件 HTML 的读取边界

面向人的交付仍为一个可离线双击打开的 HTML。报告容器把内容放入内嵌 ZIP，首页只解压导航索引，
选中页签时才解压对应报告。组合报告展开自身的导航索引，以内容引用复用叶子报告；同一报告不会因为
同时属于批量汇总和独立 Artifact 而重复存储。归档只理解 Doctor 自己的容器格式，领域 HTML 保持不透明。

iframe 隔离领域脚本，只保留当前报告，切换时释放前一页面；详情下载可以使用浏览器下载能力，
不能访问外层页面。Trace 的树骨架、节点详情与 span attributes 的分片和渲染归 Trace Harness。
这些边界同时控制首次解析和解压后的对象数量；内嵌压缩数据仍驻留浏览器，不承诺任意文件规模。
