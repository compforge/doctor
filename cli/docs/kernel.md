# CLI Kernel

## 理念 / 概念

CLI kernel 定义 Provision、Collect、Eval、Perf 和 Chat 五条并列主路径的稳定边界。它们共用底层能力，
但不共享业务流程：

- `app` 是 composition root，编排 command 的 prepare、execute 与 finalize，并注入 Plugin 与基础设施能力；
- `command` 持有五条主路径共用的启动事实、目标解析和 access/审批契约；
- `provision` 承载 image 发布、debug environment 创建和目标工具安装等显式状态变更；
- `collect/<domain>` 拥有一次确定性诊断的配置、Facts、Probes、Detectors 和格式产物准备；
- `eval` 按 canonical CaseSet 逐例触发真实请求，并调用现有 Collect 入口取得关联 Trace/Log/Data；
  它保留供下游评估的数据，不在 Doctor 内进行回答质量评分；
- `perf` 使用共享 Perf Harness 产生受控业务负载，同时触发 Metric/Trace/Log；它拥有自身加压动作，
  因而不是只做转发的纯 composite；
- `packages/agent → chat/Session → chat/Controller → chat-tui` 是独立问答链路，不依赖
  provision 或 collect；
- `model` 准备通用模型发现与 inference 访问，由 Model Collect 和 Chat 消费；Tenant 的模型 Fact 复用
  Plugin 的模型目录 capability 与领域实现，不依赖 Model Command；
- `packages/plugin` 定义 Plugin、Service 与 capability 公共协议，`plugins/<plugin>` 持有访问实现与固定业务查询；
  `infra` 只提供 Doctor 的外部资源访问能力。

### Query、Capability 与 Evidence

> Service 提供可复用的 Inspect Capability 与 Probe Capability，作为 Core 同一 Inspect / Probe 流程中的
> 业务补充：前者接受 Query 并返回 Fact（Relation 也是 Fact），后者接受 Input 并返回 Observation。
> Command 根据本次诊断目标编排 Inspect / Probe，选择并驱动 Core 实现或 Service Capability，把 Fact 与
> Observation 组织成 Evidence，再经 Detector 形成 Finding / Coverage 并最终交付报告。

这套词汇同时用于 Core 与 Plugin，不建立 Plugin 专属的平行流程。Plugin Service 是业务 Capability 的归属和
提供单元：它把私有协议、数据位置与业务语义补充到 Core 的同一条诊断流程；Core 提供通用基础设施实现、
调度、安全边界和交付。Command 是诊断视角与执行编排单元，不拥有业务数据源。

Inspect Capability 描述“业务侧能读到什么”，由 Command 的 Inspect 调度节点经 Query 调用，返回一个或
多个独立领域 Fact，但不拥有遍历和 Evidence。Relation 是一种 Fact，表达两个 Identity 之间已经由
现场数据证明的关系。例如同一模型目录可以被 Tenant、Model 与 Chat 消费，同一业务关联也可以被 Data、
Trace、Log 或 Perf 消费。

```text
Command(Config)
  → Query(Identity + Constraints)
  → Inspect Capability
  → Fact（含 Relation）
  → Evidence
```

Relation 的目标 Identity 可以形成后续 Query，但只有 Command 能决定是否继续、选择哪些 capability，
以及查询深度、数量、去重、失败隔离和停止条件。Plugin 负责 Identity、Fact 与 Relation 的业务语义和
固定查询；Core 负责 Query 调度、access 生命周期和 Evidence 组织。Capability 的 summary、table 或其它
展示投影不得反向参与 Query 调度。

Probe Capability 描述“业务侧能主动观察什么”，由 Command 的 Probe 调度节点在每个调度点以一次 Input
调用并取得 Observation；它不内建循环，也不拥有 Command 的依赖、预算、停止条件、授权或 Evidence。
Probe 调度可以调用 Core 通用实现，也可以适配 Plugin Capability；Eval/Perf 也可按各自 Harness 的调度
模型调用同一 Capability。会产生流量或改变现场的动作仍由 Command 通过 Operation 门禁和审计，不能为了
统一形状把 inference、Case 或运行时取证伪装成 Fact。

确定性诊断的核心不是“执行一组命令”，而是生成可复查的 Evidence：

```text
Command(Config)
  ├→ Inspect 调度 → Core 实现 ──────────────────────────────→ Facts ───────┐
  │             └→ Query → Inspect Capability ─────────────→ Facts ───────┤
  └→ Probe 调度   → Core 实现 ──────────────────────────────→ Observations ┤
                └→ Input → Probe Capability ───────────────→ Observations ┘
                                                                          ↓
                       Evidence → Detector → Findings / Coverage → Render → Finalize
```

| 概念 | 稳定语义 |
|---|---|
| Config | flags/profile/交互输入形成的用户意图，不进入 Facts |
| Query | Command 为一次 capability 调用形成的只读查询；由类型化 Identity 和 capability-specific Constraints 组成 |
| Identity | Query 的类型化诊断对象标识；kind 与 value 的语义由提供它的领域拥有 |
| Inspect Capability / Facts | Service Capability 响应 Query 取得的一个或多个独立领域事实 |
| Inspect / Facts | Command 行动前取得的只读现场快照；每个子 Fact 显式标记取得状态 |
| Relation | 一种 Fact，表示 Capability 从现场数据中确认的 Identity 关系；它本身不拥有后续调度权 |
| Probe Capability | Service 提供的 `Input → Observation` 业务执行原语，不拥有调度与授权 |
| Probe / Observation | Command 内的一次受限采集调度，以及它产生的结构化数据 |
| Evidence | 交给 detector 的 Observations 与领域显式挑选的 Facts |
| Finding / Coverage | 基于证据的确定性判断，以及诊断目标的证据充分度 |
| Operation | 需要授权的副作用描述，本身不执行动作 |
| Finalize | 汇总 Command 注册的 Artifacts，统一完成路径、格式、Bundle 与对外交付 |
| Evidence Bundle | 解压后单一顶层目录内由 `report.html`、`AGENTS.md`、manifest、领域 JSON、原始输出、附件和摘要组成的可审计产物 |

诊断命令未显式指定 `--format` 时采用双交付：同一 basename 下生成一份可直接打开的 `.html`，以及一份
追求信息完整度的 `.tar.gz`。Bundle 解压后只产生一个顶层目录，避免文件散落到用户当前目录；它不是
压缩 HTML，而是以领域 Evidence 为主体，并额外包含目录根 `report.html`。finalize 生成的根 `AGENTS.md`
列出可直接用浏览器打开的 HTML 完整相对路径、结构化证据阅读顺序及不可信 raw 内容边界。原先只有
JSON/HTML 的命令在 Bundle 中同时保留 `diagnosis.json` 和 HTML。显式指定
`html`、`json`、`md` 或 `bundle` 时只输出所选格式，已有格式语义不变。失败流程仍优先保存已取得的
Evidence，即使尚不足以形成成功报告。

顶层命令统一遵循 `prepare → execute → finalize` 生命周期。`prepare` 解析并校验运行条件，`execute` 只负责
领域动作并向共享 `CommandContext` 注册本轮 Artifacts，`finalize` 承担所有命令共用的收官工作。当前
finalize 的主要职责是 Delivery：单命令直接交付；多个 command 共享同一 Context 时统一汇总其 Artifacts，
多个 HTML 按 command 生成顶部 Tab；同一 command 注册多个 HTML 时在该 Tab 下继续分组。Bundle 则
一次性压缩全部已注册目录。无论领域 command 独立执行还是
被组合命令触发，都不得绕过这个阶段自行对外复制、压缩或清理产物。

所有命令在进入上述领域流程前，都经过同一条准备链路：

```text
validated Profile snapshot + command options
  → required Plugin capability + Plugin config
  → declared Host / Kubernetes environment
  → selected Target + staged access plan
  → permission check
  → CommandContext + resolved profile/capabilities
  → Provision / Inspect+Probe / Eval / Perf / Chat
  → Finalize（当前主要执行 Delivery）
```

Profile 在单次命令内只解析和校验一次，后续 target、infra 与 Plugin context 均消费这份不可变快照。
`CommandContext` 是单次顶层命令从 prepare 到 finalize 的运行作用域：Decision 复用用户或命令意图作出的
决策，Discovery 复用执行期间的只读发现，ExecutionRecord 追加保存步骤已经产生、且会影响后续 action 的
中间结果，Artifacts 保存 execute 阶段准备并交给 finalize 处理的产物路径，以及领域可选提供的聚合
basename；路径解析、覆盖保护、格式选择、复制、压缩与清理仍只属于 finalize。四者都按
类型和语义作用域隔离；ExecutionRecord 不持久化，也不等同于 Collect Facts、Observations 或 Evidence。
所有消费 profile、Target 或交互决策的领域 command 入口都必须显式接收 `CommandContext`：独立执行由
`app` 创建新实例，组合命令把自己的同一实例传给下游 command。测试依赖应放在它之后注入，不能通过把
`CommandContext` 声明为可选来绕过命令作用域。

当领域 command 需要把最终 Config 和 executor、访问句柄等运行态资源继续交给多层编排时，由该领域定义
`XxxCommandContext` 并聚合原始 `CommandContext`，不建立 `ConcreteCommandContext` 一类空泛基类。
command 完成准备后，把同一个 `XxxCommandContext` 直接传给 Inspect/Probe，不再为执行阶段复制一套
`XxxCollectContext`、`XxxInspectContext` 或 `XxxProbeContext`。这样新增 command 只需定义自己的最终运行
上下文；无论独立执行还是被 collect 驱动，差别都只在顶层 `CommandContext` 由谁创建。
Command 声明需要的 Host/Kubernetes 环境和最窄 Plugin capability；目标选择完成后，再把 Core 自身需求与
本次实际选中的 capability access 合成阶段性 access plan。配置、capability、通道或 required access
任一不满足时，命令不得进入实际采集、变更或 Agent loop。

环境准备不拥有隐式访问权。若 Service/Pod discovery 本身需要读 Kubernetes，它必须作为独立 access
need 声明；preferred discovery 被拒绝时可进入已声明的手工输入路径，required operation 被拒绝时才
终止对应阶段。这样既能在干活前暴露真实权限缺口，也不会按命令的最大可能权限过度预检。

## 代码地图

```text
cli/src/
├── app/                 命令入口、prepare/execute/finalize 生命周期、profile 与能力组装
├── chat/                AgentUE model、Session/Controller 与 Server wire protocol adapter
├── model/               Chat 与 Model Collect 共用的模型发现、选择与 inference 访问
├── plugin/              Plugin 宿主侧的选择、上下文与加载边界
├── command/             启动检查、Kubernetes 目标解析、执行上下文与 access/审批契约
├── provision/           image、debug environment 与目标工具准备
├── case/                Eval 与 Perf 共用的 Case 请求身份选择
├── eval/                CaseSet 逐例触发、Observation 与关联证据编排
├── perf/                主动负载、Perf Harness 适配和可观测证据编排
├── protocol/            CLI ↔ doctor-server 协议与 SSE client
├── terminal/            命令共用的选择、输入、确认与输出边界
├── collect/
│   ├── protocol.ts      Facts、Observation、Finding、Coverage 等共享协议
│   ├── engine.ts        Facts → Probe → Evidence → Detector/Coverage
│   ├── *-engine.ts      Inspect、Probe 与 Strategy 调度
│   ├── evidence.ts      Worksheet 与 Evidence Bundle
│   ├── operation.ts     副作用授权和审计
│   ├── output/          Bundle、Markdown、HTML 等领域产物的生成原语
│   └── <domain>/        领域 config/fact/probe/detector/render
└── infra/               Host、Target、K8s 与各类外部资源 adapter
    └── dump/            Target heap dumper backend 与 Toolkit bundle 适配

packages/agent/          CLI 与 server 宿主共用的 Agent、Skill 输入与 AgentUE 输出
packages/plugin/         Plugin、Service Catalog 与 capability 公共协议
plugins/<plugin>/        具体 Plugin 的 Catalog、领域模型与固定业务查询
```

目录按真实职责生长，不为概念对称提前创建空层。跨领域 Fact、Probe 或 infra 只有出现稳定、同语义的
重复时才上提；表面相似但诊断口径不同的逻辑继续留在各自 domain。

## 运行形态与执行位置

profile 决定 CLI 能呈现的能力，而不是让不同执行模型互相渗透：

| 条件 | 能力形态 |
|---|---|
| 零配置 | 使用本地 kubeconfig 的确定性诊断 |
| 配置 `llm` | `doctor chat` 默认运行本地 Agent |
| 配置 `server` 且显式 `--server` / `--resume` | 连接 doctor-server 的远端 Agent |

direct collect 不创建 connection、conversation 或 SSE，也不承担开放式 agent 推理；server mode 不把
server 内的工具执行细节搬回 CLI。本地模式由 CLI interface 驱动 `packages/agent`；远端模式由
`ServerAgent` 把 server wire protocol 投影为 AgentUE。`server` 只声明 endpoint，不隐式改变运行位置；
server 宿主通过自己的 interface、凭据、执行环境和持久化 adapter 使用同一 Agent 实现。

执行位置属于能力身份：

- **Doctor Host** 是运行 CLI 的工作站或部署机，拥有本地文件、网络入口、container engine 和离线 analyzer；
- **Target** 是本轮被诊断的 Pod、container、进程、远端服务或数据对象；
- Host 与 Target 的文件传输由 `infra/file-transfer` 表达，路径和方向必须显式命名；
- 某侧缺少能力时，错误必须指出缺的是 Host 还是 Target，不能用全局 `available` 混合表达。

Kubernetes 是 Doctor Host 到 Target 的一种访问通道。`app` 完成通用准备并形成 `CommandContext`，各命令再按实际
资源作用域声明 `required` 或 `preferred` access contract：required 被明确拒绝时停止当前阶段；
preferred 被拒绝时进入手动输入或低能力降级；`kubectl auth can-i` 无法判断时保留 `unknown`，由实际
操作给出最终结论。权限上下文按 executor 缓存，但不进入诊断 Facts/Evidence。

命令的前置条件沿两条正交能力轴表达：Core access 描述如何接近和安全操作 Target，Plugin capability
描述目标是什么、业务数据在哪里以及数据语义。Core command 不依赖 Plugin；Plugin command 始终注册，
但在创建 `CommandContext` 和访问 Kubernetes 前先验证 Doctor Host 已加载 Plugin 且具备 required
capability，缺失时直接说明具体 capability。preferred capability 缺失只触发声明过的降级路径。
命令应声明自己真正消费的最窄业务契约：例如 `doctor trace` 和 `doctor log` 消费规范 `trace_id`，因此
依赖 `service.traceId`，而不是借用宽泛的 `service.inspect` 或在 OpenSearch 中猜测业务 ID 语义。

```text
Command requirements
├── Plugin capability      业务目标、数据来源与语义
├── Core access contract   Host/Target/Kubernetes 访问条件
└── Operation              副作用上限与用户授权
```

Core 与 Plugin 的稳定协议面只有 access、data、infra、config：access 是 capability 的声明，data 是调用
输入输出，infra 是 Core 为选中 Target 提供的运行便利，config 是 profile 对 Plugin-owned schema 的不透明
透传。四者分开后，Core 不必理解业务配置，Plugin 也不能把获得 infra handle 等同于获得任意权限。

```text
Command orchestration
├── Access plan = Core command needs + selected Service capability needs
├── Core infra ──Target-scoped helpers──> PluginContext
└── Plugin capability ──typed data/handle──> Evidence pipeline

Plugin (versioned distribution unit)
├── Service Catalog
│   ├── Service A ── capabilities + access declarations
│   └── Service B ── capabilities + access declarations
└── Skills
```

访问检查在实际工作之前、按当前阶段惰性发生，不能以命令可能使用的最大权限提前阻断低能力路径。例如 `doctor debug` 已有
可复用 debug container 时不需要 `update pods/ephemeralcontainers`；只有确实需要注入时才检查该权限。

### 业务型、基础设施型与混合型命令

Collect command 按诊断算法和数据语义的所有者分为三类。这个分类用于判断 Core 与 Plugin 的职责，
不是目录拆分规则；同一个命令可以先消费业务 capability，再进入标准基础设施诊断。

| 类型 | 典型命令 | Plugin 负责 | CLI Core 负责 |
|---|---|---|---|
| 业务型 | `data` | 定位业务 Service，经 Core access 取得运行态事实，执行固定 HTTP/DB 查询并返回约定结果 | 提供 Target-scoped access，触发 capability，编排 Evidence、Detector/Coverage 和展示 |
| 基础设施型 | `store`、`mem`、`net` | 按需贡献目标身份、连接配置或默认选择，不实现通用基础设施诊断 | 执行标准探测与分析，控制风险、资源生命周期和证据交付 |
| 混合型 | `trace`、`log`、`tenant`、`model`、`mcp` | 处理业务入口、私有 schema 和目标投影 | 消费规范目标后执行通用采集、协议分析和报告 |

Kubernetes 的分工遵循同一所有权：Core 解析当前 profile 的 kubeconfig/context，但只向 Plugin 注入
namespace、Service 身份和 Target-scoped Kubernetes access，并统一托管超时、输出上限、取消与
port-forward 回收；Plugin 用该 access 自行解释 selector、定位 Pod、读取运行时配置。Core 不预先读取
selector、Pod、container 或 env 再回传给 Plugin，Plugin 也不持有 kubeconfig 或自行启动 kubectl。
只有 Kubernetes 操作本身属于 Core command 时，例如 `log` 读取 Pod 日志、`mem` 操作目标进程，Core 才
负责定位和操作对应 Target，并声明实际需要的 access contract。

混合型命令按阶段保持边界。例如 `trace` 先由 Plugin 把业务 ID 解析为规范 `trace_id` 并贡献
OpenSearch 目标，再由 Core 按 OTel/Jaeger 语义下载和分析 span；`inspect` 的 Deployment env 由 Core
采集，`tenant` 的租户配置由 Plugin 取得。`collect` 不因上述分类拆成 `biz/infra` 两套框架。

### Application 数据按作用域拆分

Application 数据不是一个单一粒度的数据面。`doctor tenant` 与 `doctor data` 都是数据采集 Command：
前者以 tenant-id 为根 Identity，采集租户粒度 Fact；后者以 biz-id 为根 Identity，采集业务对象粒度 Fact。
Relation 作为 Fact 的一种表达 Identity 关系。二者的差异是 Query 作用域和 Evidence 组织，不是是否
采集数据。当前 Tenant 尚无 Relation 的实际 case，但后续遍历仍由 Tenant Command 决定，不能下沉为
Capability 自递归。
新的 identifier 只有在查询流程、证据生命周期和用户心智均独立时才形成新的 scope command，不能仅因
查询键不同就增加命令，也不能继续扩张 `data` 或让 `collect` 理解 identifier 之间的私有关联。

Tenant Command 只生成单个 `tenant_id` Identity 的 Query，并选择声明接受该 Identity 的可复用
Capability。模型清单直接来自 Model Catalog；其它租户事实来自 Service Inspect Capability。Plugin 拥有
具体查询和 Fact / Relation 语义，Command 拥有结果选择、Evidence、Coverage 与展示，不再设置一层
Command-specific tenant contribution 协议。

这些作用域 command 可以复用同一个 `CommandContext` 中已经确认的 profile、namespace 和同语义决策，
但不能相互推导未声明的 identifier。`collect` 只组合被选择的数据面和产物，因此增加新的 Application
作用域时，不需要把该作用域的数据模型并入集合层。

## Collect 共享协议

Collect 的结果不是成功/失败二态，而是命令终止、诊断覆盖度与产物交付三个正交维度。只要流程正常
结束、形成可解释的部分证据并成功交付报告，`partial` 也是成功完成；报告必须醒目标明缺失证据、原因
及不能支持的结论。Finding 严重度只描述 Target 健康，不改变命令完成语义。

Collect 仍遵循 Config → Facts → Observations → Evidence → Findings/Coverage → Render 的单向数据流。
单项 Probe 失败只降低相应 Coverage，不阻断其它独立 Probe；未声明可降级处理的异常继续向上抛，避免
把 Doctor 自身错误伪装成部分完成。完整状态、调度、Evidence、退出码与授权契约见
[`collect-protocol.md`](collect-protocol.md)。

## 关键边界

### Provision 与 Collect

两者都可能执行非只读动作，边界取决于主要结果：Provision 以外部能力准备完成为结果；Collect 以
可审计 Evidence 为结果。Collect 不会为了绕过前置条件隐藏式发布 image、创建 debug environment 或
安装工具；能力不足时说明缺口，由用户独立运行对应准备命令。

Provision 不使用统一 engine。image、debug、install 的结果和生命周期不同，因此各自拥有检查、授权、
执行和验证流程，只共享 `CommandContext`、terminal 交互和 infra 原语。

### Eval 为什么单列

Eval 的主要动作是按一个版本化 CaseSet 逐例产生真实请求，并把 CaseSet 快照、协议 Observation 与关联的
Trace/Log/Data 一起交付。它不是只观察既有现场的 Collect，也不具有 Perf 的并发档位、请求预算、熔断和
窗口归约，因此保留顶层入口。Case 的 canonical 资产归 spec-case，单次请求协议归 Service Case Capability；
Eval 只负责选择 Case、顺序调度一次和证据编排。CaseSet 中可保留 `judge.eval` 等下游评估配置，但 Doctor
Eval 不解释或执行这些配置，也不产出回答质量分数。

Eval 调用既有 Trace、Log、Data Command 的稳定采集入口并共享 `CommandContext`，不能在 `eval/` 下复制
采集实现。缺少关联 ID 或某类可选 capability 时，报告明确记录该数据面不可用，同时保留已取得的 Case
Observation；已声明且实际执行的采集器失败则使本次命令失败。

### Perf 为什么单列

Perf 的主要动作是主动产生业务请求，结果是负载曲线与其对应的可观测证据。它既不是为后续诊断准备
环境的 Provision，也不是只观察既有现场的 Collect。`doctor perf` 因而与 `doctor chat` 一样保留顶层
入口：Core 负责共享负载契约、安全边界、窗口和报告；Plugin 的 Case capability 负责具体 Service 的
单次请求协议与协议判定，Perf capability 只声明 Case 组合和关联范围。Metric、Trace、Log 的采集仍调用
现有 Collect 实现，不在 Perf 下复制第四套采集器。

### 依赖方向与领域所有权

`app` 可以组装 Plugin、`provision`、`collect`、`eval`、`perf`、`chat` 和 `infra`。Provision、Collect 与
Chat 保持互不依赖；Eval 和 Perf 是编排层，会有意调用 Collect 的稳定入口，但不能复制其采集实现。
共同启动上下文、Kubernetes 目标解析和审批模型归 `command`，交互归 `terminal`，执行原语归 `infra`。
`packages/agent` 与 `packages/plugin` 不依赖 CLI，具体 Plugin 只依赖 Plugin 公共包；CLI infra 实现
Plugin 公共包定义的 access port，但不知道业务
Service、表关系和诊断结论。Plugin loader 把当前精确 Plugin 版本的 Skills 解析后交给本地 Agent，Agent
不扫描独立的 Skill 目录。

Plugin 是多个 Service 与 Skill 的版本化分发单元；Service capability 才是业务能力与 access 的运行时
选择单位。命令只把实际参与本次调用的 Service capability 合入 access plan，不能因为同一 Plugin 还打包了
其它 Service 就预检整包最大权限。

运行时配置、Probe 生命周期、Evidence 适配和采集编排属于 `collect/<domain>`；Service 协议、固定查询
和 Plugin capability 分别属于 `packages/plugin` 与 `plugins/<plugin>`；Registry、container engine、
package manager、文件传输和外部 client 属于 infra。Service Catalog 声明“可能提供什么”，具体部署
是否启用由运行时 Facts 判断。

Service 定义只由身份字段和 `capabilities` 容器组成。Catalog 只提供 `find`、`findWith`、`servicesWith`
三种通用发现操作，不为每种能力增加专用方法；Store 选择等领域语义由对应 capability 模块提供 helper。
Plugin 原始配置 schema、解析规则和请求模板留在 `plugins/<plugin>`，必要时投影成中性 capability 接口供
collect 消费，不能让 collect 反向知道某个 Plugin 的配置 key 或内部对象。

### 入口、TUI 与终端输出

Command 同时服务交互用户和自动化调用：domain 只提供候选与选择语义，共用 prompt 和输出机制归
`terminal`。chat-tui 只依赖 `Controller` 提供的 view state 与 intent；`Session` 只接收 AgentUE patch，
不直接解释 pi 或 server wire 字段。doctor-server wire schema 由 `ServerAgent` 收口。

### CLI 与 Toolkit 分发

CLI core 只依赖 Node-compatible API，从同一个入口构建各平台单文件。诊断 executable、debug image 与
离线系统包归独立版本的 Doctor Toolkit，不进入 CLI 单文件。`infra/toolkit` 先根据 Host process、Host
container 或 Kubernetes container 的实际 OS/arch 选择并校验资源；需要共同演进的组件还必须按协议与
runtime compatibility 从同一个 archive 解析成完整 bundle，再交给对应 `infra/host`、`infra/dump`、
container engine 或 Kubernetes adapter 执行。Doctor Host 平台不能替代 Target 平台。

Host 上同一能力同时具有 container 和 process backend 时，由 `infra/host` 自动探测：优先复用已经可用的
本地 container engine 与工具 image，不能满足能力要求时再回退本机进程。这里只观察已有能力，不会为了
命中优先通道而隐式 load image；需要准备 image 时仍由 Provision 明确完成。

Linux x64 CLI 同时提供 modern Bun 与 glibc 2.17-compatible Node SEA；无法证明 Host 满足 modern 基线时
保守选择兼容产物。具体版本、文件名、校验和与发布矩阵以各自 Makefile、manifest 和 CI gate 为事实源，
不在设计文档复制。

## Command 文档约定

每个 `doctor <command>` 只在 `docs/commands/` 维护一篇文档，描述领域理念、主流程和不能从单文件代码
看出的关键设计；共享执行协议只在本文定义，字段、阈值、参数和实现形状留在代码。命令文档如下：

| Command | 文档 |
|---|---|
| Collect（集合命令） | [`commands/collect.md`](commands/collect.md) |
| Inspect | [`commands/inspect.md`](commands/inspect.md) |
| Tenant | [`commands/tenant.md`](commands/tenant.md) |
| CPU | [`commands/cpu-diagnosis.md`](commands/cpu-diagnosis.md) |
| Data | [`commands/data-diagnosis.md`](commands/data-diagnosis.md) |
| Debug | [`commands/debug-container.md`](commands/debug-container.md) |
| HTTP | [`commands/http-diagnosis.md`](commands/http-diagnosis.md) |
| Image | [`commands/image.md`](commands/image.md) |
| Install | [`commands/install.md`](commands/install.md) |
| Log | [`commands/log-diagnosis.md`](commands/log-diagnosis.md) |
| MCP | [`commands/mcp-diagnosis.md`](commands/mcp-diagnosis.md) |
| Memory | [`commands/memory-diagnosis.md`](commands/memory-diagnosis.md) |
| Metric | [`commands/metric-diagnosis.md`](commands/metric-diagnosis.md) |
| Eval | [`commands/eval.md`](commands/eval.md) |
| Perf | [`commands/perf.md`](commands/perf.md) |
| Model | [`commands/model-diagnosis.md`](commands/model-diagnosis.md) |
| Network | [`commands/network-diagnosis.md`](commands/network-diagnosis.md) |
| Store（DB/VDB/S3/Redis） | [`commands/store-diagnosis.md`](commands/store-diagnosis.md) |
| Trace | [`commands/trace-diagnosis.md`](commands/trace-diagnosis.md) |

新增 command 时先定义 Facts、Observations、Evidence/Findings/Coverage 和纯 detector，再实现 Inspect/Probe
与 renderer；契约测试至少覆盖依赖调度、能力降级、授权拒绝、敏感信息边界和交付结果。若新增内容只是
共享协议的一个 case，更新本文或代码即可，无需创建横切专题文档。
