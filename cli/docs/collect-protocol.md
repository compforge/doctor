# Collect 共享协议

## 理念 / 概念

Collect 形成可复查的 Evidence 与 Findings。`CommandStatus` 描述本次选定采集工作的执行结果：
`ok / partial / failed / cancelled`；产物交付失败会改变最终命令状态。Detector 对已有证据给出判断，
包括异常和证据不足。Finding 的严重度与数量不决定采集是否成功，也不证明 Target 健康。

查询成功但没有记录仍是成功；它可以让 Detector 无法支持某个结论。未选择或已证明无需执行的可选工作
不降低命令状态。已经选择的工作发生失败、部分返回或预算截断时，保留实际取得的数据与执行原因。
全部已选工作完成为 `ok`；一部分成功为 `partial`；没有取得任何已请求结果或交付失败为 `failed`。

Diagnosis 只包含 `evidence` 和 `findings`，没有独立的 Coverage、RuleOutcome 或 AssessmentStatus。
证据不足 Finding 与其它 Finding 共用身份、版本、producer 与 EvidenceRef；只有存在具体限制时才产生，
不为每个规则或诊断目标生成成功/不适用记录。历史归档中的 coverage 字段不参与新报告或状态推导，
仍按原有 execution、Facts、Observations 和 Findings 读取。

Evidence Bundle 同时保存原始输出、步骤和结构化状态。固定证据面使用 Worksheet 预声明 Outcome，
每格只填一次；完整取得记为 `ok`，部分取得记为 `partial`，访问失败、前置不可用和已证明无需取得分别
记为 `failed / unavailable / unnecessary`。收尾仍未填的格子必须 settle 为明确缺失原因。

### Trace、Log、Metric 是三个基本可观测数据面

Doctor Collect 把 OpenTelemetry 的三类基本信号作为正交证据面：Trace 解释一次请求跨 Service 的因果与
耗时分布，Log 保留离散业务事件和错误上下文，Metric 描述一段时间内的总体趋势与资源/业务指标。三者
可以通过 `trace_id` 和时间窗口对齐，但不能互相代替；CPU 不高也不能据此推断首 token 延迟正常。

`doctor perf` 不另造采集协议。它负责产生刺激、封口压测窗口，并从请求 Outcome 中保留 Plugin 声明的
`trace_id` / `message_id` 等关联键；窗口内调用现有 `doctor metric`，结束后把代表请求的业务 ID 交给
现有 `doctor trace` 和 `doctor log`；Log 自行匹配输入 key 并按声明扩展关联，不要求 Trace 成功。
某个数据面因权限、保留期或现场部署缺失时，已取得的其它证据仍应交付，并把命令结果标为
partial，而不是把缺数据解释为系统健康。

## 执行数据模型

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
契约属于实现错误，不能伪装为证据不足。Fact 不另设对象 ID，Detector 通过本轮 Evidence 中的
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

Plugin Workload Probe 通过 `produces: ObservationDefinition` 声明 kind、schemaVersion 和 ValueCodec。
Value/Codec 约定 Core 与 Plugin 间复合数据的保存、恢复和摘要，领域结构与校验归 Plugin。
Core 检查无损 JSON 和大小预算，保存编码数据及采集时 Summary；历史阅读不执行当前 Plugin。
显式恢复使用调用者提供的匹配 Codec，不依赖当前 Probe 注册。详见 [Extension 数据契约](extension.md)。

### Evidence、Detector 与 Diagnosis

Evidence 的持久化布局、清单与正文边界见 [Command 输出规范](command-output.md)。

Evidence 是本次诊断明确选择的 Facts 与 Observations。Detector 回答“已有证据说明什么”：

- Core Detector 提供跨业务通用判断。
- Service Detector 提供业务判断，可以关联跨 producer、跨 Service 的 Evidence。
- Detector 不接收 `CommandContext`、`PluginContext` 或 infra handle，不执行 I/O。
- Finding 必须显式引用 Evidence 中的 `factPath` 或 `observationId`。
- Core 通过同一个 Detector runner 执行 Core Detector 与适配后的 Service Detector，并校验 Finding 身份、
  producer、Evidence 引用和本轮唯一 ID；违反契约属于实现错误，不能伪装为证据不足。
- 证据不足由 Detector 产生 Finding，不表达 Target 是否健康，也不决定 CommandStatus。

Fact、Observation 与 Finding 使用 `kind + schemaVersion` 标识 payload schema。Core kind 使用保留短名；
Plugin 本地 kind 由 Core 规范化为 `plugin/<plugin-id>/<service>/<local-kind>`。两者都携带结构化 producer，
消费方不能通过解析 kind 字符串猜测来源。Plugin version 标识实现版本，`schemaVersion` 只标识数据契约。
`cli/src/plugin/evidence.ts` 是 Core/Plugin Service Evidence 的统一适配边界：Core Fact/Observation 原样继承
已持久化 identity，Plugin 本地 schema 在这里统一补 namespace 与 producer；领域 projector 只拥有披露和
Service 关联决策，不能再次手写或改写 identity。

## 流程

Core 统一驱动三段式生命周期；Plugin Service 只注册 Inspect、Probe、Detector contribution，不自行推进
阶段，也不接管 Render、Delivery 或 Cleanup。

1. **Prepare**：合并 CLI、profile 与交互输入，确定目标身份和本轮选中的 Core / Plugin Service
   contribution；建立 port-forward、临时文件等访问条件，并登记其清理责任。
2. **Execute / Inspect**：`runCollect` 统一驱动自身 Inspect 与选中 Plugin Service 注册的 Inspect
   contribution；底层 `runInspects` 按依赖取得 Facts，校验每个叶子 Fact 的
   `kind / schemaVersion / producer`，并要求 Core producer 指向实际执行的 Inspect；每个 Fact 一经取得便在
   本轮后续只读。Core 按诊断目标
   生成 Query，将返回数据保存为 Facts；Relation 作为 Fact 的一种保留已确认的 Identity 关系；没有业务
   Inspect contribution 的 Command 可跳过此步。需要在长 Probe 前保留阶段证据时，Core Command 可通过
   `checkpointFacts` 持久化完整的冻结 Facts；checkpoint 不采集或修改 Facts，也不构成新的 Execute 阶段。
3. **Execute / Probe**：全部 Inspect 完成并深冻结 Facts 后，`runCollect` 才调用 `planProbes(facts)`；Core
   由领域显式选择公开的 Facts、Service scope、`factPath` 与 value shape，再通过共享 adapter 建立公共投影，
   将同一份 Facts 注入 Core Probe 与选中 Plugin Service 注册的 Probe contribution，再驱动它们产生
   Observations；adapter 保留原始 identity，不递归遍历 Evidence 或派生伪 Fact；当前选出的投影不按
   Service、producer 或 kind 过滤。单项现场访问失败写入执行结果，独立 Probe 继续执行。
4. **Execute / Detector**：Evidence Builder 组合 Inspect Facts、Contribution Facts（含 Relation）与 Observations；
   Core 通过 `runDetectors` 驱动自身通用 Detector 与本次选中 Plugin Service 注册的纯 Evidence Detector，
   校验 Finding 的 `id / kind / schemaVersion / producer`、本轮 ID 唯一性及 Evidence 引用后形成 Findings；
   同一阶段也用 Finding 解释证据不足及其影响。
5. **Finalize**：根入口释放共享 Client，序列化完整结果，再按格式触发本地 Renderer 和 Delivery；
   具体阶段顺序见 [Command 生命周期](command-lifecycle.md#三阶段生命周期)。

`runInspects`、`runProbes` 与 `runDiagnosis` 是 Collect engine 的低层实现入口；新增领域 Command 必须通过
`runCollect` 进入 Execute。所有领域 Command 已完成迁移，架构测试禁止 `collect/<domain>` 直接调用这些
低层 runner；它们只由 `collect/engine.ts` 组合。

Facts、Config 和执行态 Ctx 必须分开：Facts 不保存密码、原始 DSN 或 Probe 运行结果；带凭据 Target
只存在于本轮 Ctx，进入 manifest 和 Detector 前使用领域脱敏投影。Detector 可以读取 Evidence 中领域
显式选择的 Facts 解释证据为何缺失，但不能追加 I/O。
缺失身份、producer 不匹配、重复 ID、空 Evidence 或引用本轮不存在的 `factPath / observationId` 都是
Collect 契约错误，不能伪装成 partial。身份与投影规则见上方执行数据模型。

### 批量执行

`runCollectBatch` 是共享采集引擎的列表入口：一次 Inspect 和 Facts checkpoint 完成后，再对各项
投影事实并执行 Probe → Detector。单项异常和排队取消有独立结果；并发调度只决定业务项何时推进，
实际外部访问仍受根 Context 的容量约束。投影继承原始事实身份，不通过回放 Inspect 制造另一轮采集。

## 关键设计

### 完成状态不由单个 Probe 决定

Probe 的 `onFailed` 是现场失败的显式降级契约。声明它表示 runner 可以把异常记录为证据缺口并继续；
未声明时异常仍向上抛，因为依赖成环、重复记账、解析不变量被破坏等 Doctor 自身错误不能伪装成
partial。依赖 Probe 除 Observations 外还会收到上游的状态和原因，以便把失败准确投影为 unavailable，
而不是误判成 unnecessary。

同一 Probe 的多个 `ProbeStrategy` 表示取得同一种 Observation 的升级链。策略返回发生了什么以及是否
继续；runner 不替领域猜测失败后是否值得升级。`dependsOn` 只描述真实数据依赖，`targetAccess` 表达
整条策略链可能产生的最大影响。

### 执行状态、诊断判断与交付分开

| CommandStatus | 含义 | 退出码 |
|---|---|---:|
| ok | 已选工作完成且交付成功，允许查询返回空结果 | 0 |
| partial | 已选工作部分完成，已取得证据继续交付 | 0 |
| failed | 已选工作失败或产物交付失败 | 1 |
| cancelled | 用户取消，保留已取得证据 | 130 |

参数错误仍返回 2。命令之间传递 `CommandResult`，根 CLI 负责退出码映射。自动化读取命令状态与
采集记录判断执行是否完成，读取 Findings 判断已有证据说明了什么；不从 Finding 数量、严重度或
业务记录行数反推执行状态。

固定采集结果复用 EvidenceBundle 中声明的 Outcome；中间失败后由后续策略成功取得相同证据时，
最终 Outcome 为成功，中间失败保留在步骤记录中。Workload Probe 返回 `{ value, status, reason? }`，
`status` 为 `ok / partial / unavailable`，后两者必须说明原因。Core 保存 Value 与状态，不解析 Plugin
私有 payload 来猜测是否完整；Codec 只负责数据持久化与恢复。Core 继续通过既有 `Service.workloads`
发现 `WorkloadInstance`，逐实例调用 Probe。

### Partial 仍交付用户请求的报告

Partial 报告沿用用户请求的 HTML、Markdown 或 Bundle 格式，并必须展示：已取得的证据、失败或不可用
步骤、缺失原因和不能支持的结论。非零退出码不应直接决定产物类型；完全无法形成有效
诊断时仍保留失败原因和原始证据。单个 Renderer 失败不阻断其它页面；渲染与交付错误使根退出码非零，
并保留临时证据。是否打包按用户选择的 format 决定，子命令不另行交付失败包。

时间或样本预算耗尽时，报告保留已采样部分和停止原因。用户拒绝可选采集项时记录 skipped，
但不把未选择的工作计为失败；Detector 仍可解释该选择限制了哪些结论。

报告保持单文件、离线可读。`CommandSpec.render` 在根 Finalize 中消费本地结果；公共 `report` 模块拥有
阅读结构、对象联动和按需加载，公共 output 提供 shell 与通用表格/图表；领域 Renderer 决定
章节顺序、文案与数据口径，不从 Markdown 文案反解析结构化数据。具体契约见 [渲染设计](rendering.md)。

### 副作用与授权

| mode | 含义 |
|---|---|
| `observe` | 不主动改变业务进程或 Pod 状态 |
| `overhead` | 允许 profiler、handler 等受控诊断负担 |
| `disrupt` | 允许安装、注入、临时容器、rollout 或产生持久业务数据的主动负载等显式影响 |

mode 是副作用上限，不是 blanket approval。Operation 描述 `risk / target / impact / steps`，具体执行与
清理由 Probe 或 Provision 工作流拥有。授权发生在动作真正需要执行时；用户拒绝只终止依赖该 Operation
的 Strategy，不应吞掉其它只读证据。

## 取消、清理与失败证据

共享执行器在调度 Inspect、Probe、策略和 batch item 前检查当前命令的取消信号。
取消后保留已完成的 Observation，停止后续调度和 Detector 判定；领域通过 partial Fact checkpoint
保存已完成的 Inspect 投影，未完成的 Facts 不作为完整输入交给 Probe。
超时通过共享 deadline 给实际 I/O owner 发送 AbortSignal，由 Client 中断请求；不会用 Promise race
假装已经停止仍在写入证据的工作。Plugin 同样必须遵守 signal。

临时资源与共享 Client 清理各有 5 秒等待预算；清理失败或超时保留已经返回的 output 和 staged artifacts，
继续归档。超时不能强制终止不合作的 Plugin 代码，也不重试其 disposer。
命令结果可携带统一的 diagnostics，归档写为 `diagnostics.json` 并在 manifest 中索引。
诊断记录阶段、目标、耗时、kind/code 和有界 cause 链，移除 URL 凭据、查询值及常见凭据字段；
不复制 stack、任意异常属性或协议 body。终端简短原因与这份排障证据分开。
