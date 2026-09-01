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
  → Render（领域输出投影，触发位置沿用现状）
  ↓
Finalize
  → Artifact / Bundle
  → Delivery / Cleanup / exit status
```

Inspect 与 Probe 之间存在阶段屏障：选中的 Inspect 全部收敛并冻结 Facts 后，Core 才生成 Probe 计划。
Detector 只能在 Observations 汇总成 Evidence 后运行。Plugin Service 只注册 contribution；阶段推进、
调度、失败隔离和收尾始终由 Core 控制。

### Core 与 Plugin Service 分工

| 阶段 | Core | Plugin Service |
|---|---|---|
| Prepare | 解析并校验用户意图；选择 Target、Service 与 contribution；合并 Core/Plugin access needs；创建本轮上下文和清理责任 | 声明 Service、Workload、capability、dependency、access 与 contribution；校验 Plugin-owned config；不自行创建命令生命周期 |
| Inspect | 形成 Query；决定 Inspect 的依赖、顺序、预算、遍历、去重和失败隔离；驱动 Core/Plugin Inspect；规范化并冻结 Facts | 执行一次业务 Inspect，返回 Fact/Relation；拥有私有协议和业务数据语义，不拥有遍历或后续调度 |
| Probe | 根据冻结 Facts 生成计划；向 Probe 注入公共 Fact；控制依赖、策略、授权、风险和资源生命周期；驱动 Core/Plugin Probe | 执行一次业务 Probe，消费 Input/Facts 并返回 Observation；不内建循环、并发或跨 Probe 调度 |
| Detector | 构建 Evidence；统一执行 Core/Plugin Detector；校验证据引用与 provenance；形成 Coverage 和 Diagnosis | 提供纯业务 Detector，消费只读 Evidence，返回带显式证据引用的 Finding；不接收运行上下文或发起 I/O |
| Finalize | 驱动领域 Renderer，组装 Artifact/Bundle，完成 Delivery、Cleanup 与最终退出语义 | 不拥有阶段或资源生命周期；业务语义已通过 Fact、Observation 与 Finding 进入 Diagnosis |

Plugin 不必在每个阶段都有可执行逻辑。Prepare 中它主要提供声明，Execute 中贡献业务采集和判断，
Finalize 则由 Core 收口。Renderer 的领域逻辑与当前触发位置仍归 `collect/<domain>/render`；Finalize 只消费已准备的产物。

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

RelationFact 可以形成后续 Query，但只有 Core Command 能决定是否继续，以及查询深度、容量、去重、
失败隔离和停止条件。Plugin 拥有 Identity、Fact、Relation 的业务语义与固定查询，不拥有自递归调度。

### Probe 与 Observation

Probe 回答“针对已确认目标，本次主动观察到了什么”。Core 根据冻结 Facts 选择并驱动 Core Probe 与
Service Probe。当前 Service Probe 取得本轮完整的公共 Fact 投影，不按 Service、producer 或 kind 过滤；
所有 Probe 共享同一份深冻结快照，只能消费，不能修改或追加 Fact。

Probe 是一次执行原语：可以使用 Core 提供的 Target-scoped infra 和授权入口，但不拥有 Command 的循环、
并发、预算、停止条件或 Evidence。Observation 只陈述某个探测时间点或时间窗口看到的状态，不能默认
代表之后的现场。Probe 之间的真实数据依赖显式声明；会产生负担或改变现场的动作必须经过 Operation
授权。

### Evidence、Detector 与 Diagnosis

Evidence 是本次诊断明确选择的 Facts 与 Observations。Detector 回答“已有证据说明什么”：

- Core Detector 提供跨业务通用判断。
- Service Detector 提供业务判断，可以关联跨 producer、跨 Service 的 Evidence。
- Detector 不接收 `CommandContext`、`PluginContext` 或 infra handle，不执行 I/O。
- Finding 必须显式引用 Evidence 中的 `factPath` 或 `observationId`。
- Coverage 表达诊断目标的证据充分度，不表达 Target 是否健康。

Fact、Observation 与 Finding 使用 `kind + schemaVersion` 标识 payload schema。Core kind 使用保留短名；
Plugin 本地 kind 由 Core 规范化为 `plugin/<plugin-id>/<service>/<local-kind>`。两者都携带结构化 producer，
消费方不能通过解析 kind 字符串猜测来源。Plugin version 标识实现版本，`schemaVersion` 只标识数据契约。

## 共享生命周期边界

### Prepare

所有顶层 Command 都先完成同一条准备链路：

```text
validated Profile snapshot + command options
  → required Plugin capability + Plugin config
  → declared Host / Kubernetes environment
  → selected Target + selected contributions
  → staged access plan + permission check
  → CommandContext + resolved capabilities
```

Profile 在一次 Command 内只解析和校验一次。`CommandContext` 是从 Prepare 到 Finalize 的运行作用域：

- Decision 复用已经确认的用户或命令意图。
- Discovery 复用执行期间的只读发现。
- ExecutionRecord 保存会影响后续动作的临时执行结果。
- Artifacts 保存交给 Finalize 处理的领域产物声明。

运行态 executor、临时 handle 和凭据属于 Context，不进入 Facts/Evidence。独立 Command 由 `app` 创建
Context；组合 Command 把同一实例传给下游稳定入口。配置、capability、执行通道或 required access 不满足
时，不得进入 Execute。

### Finalize

Finalize 只消费 Execute 准备的产物元数据和已登记的 Artifacts，统一完成路径/格式处理、
Bundle、Delivery、Cleanup 与退出状态。领域 Command 不自行对外复制、压缩或交付产物；组合 Command
也不复制子 Command 的渲染和打包逻辑。

默认格式、partial 报告、Evidence Bundle、失败兜底和退出码语义由
[`collect-protocol.md`](collect-protocol.md) 统一定义；具体 Command 文档只描述自身 Diagnosis 和展示差异。

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
├── command/             CommandContext、Target、access 与审批契约
├── collect/
│   ├── protocol.ts      Fact、Observation、Finding、Coverage 共享协议
│   ├── engine.ts        runCollect：Inspect → Probe → Evidence → Detector / Coverage
│   ├── inspect-engine.ts  Inspect 依赖调度与 Facts 冻结
│   ├── probe-engine.ts  Probe 依赖、安全顺序与失败隔离
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
- [`commands/collect.md`](commands/collect.md)：集合命令如何组合多个 Collect 入口。
- [`commands/tenant.md`](commands/tenant.md) 与
  [`commands/data-diagnosis.md`](commands/data-diagnosis.md)：Application 数据的 Query 作用域。
- [`commands/eval.md`](commands/eval.md) 与 [`commands/perf.md`](commands/perf.md)：Case 执行和主动负载。
- [`../../toolkit/README.md`](../../toolkit/README.md)：Toolkit 的独立版本与平台资源模型。
- [`commands/`](commands/)：各领域 Command 的理念、流程和关键设计。

新增 Collect Command 时，先定义 Facts、Observations、Evidence、Findings/Coverage 和纯 Detector，再实现
Inspect、Probe 与 Renderer；契约测试至少覆盖依赖调度、能力降级、授权拒绝、敏感信息边界和交付结果。
