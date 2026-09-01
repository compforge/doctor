# Collect 共享协议

## 理念 / 概念

Collect 的目标是形成一份诚实、可复查的诊断产物，而不是要求每个外部访问都成功。一次运行由三个
正交维度描述：命令是否正常终止、诊断证据覆盖是否充分、请求的产物是否成功交付。Target 中是否存在
critical Finding 是诊断结论，不属于命令成功语义。

Coverage 分为 `sufficient / partial / insufficient`；跨领域的 Evidence 完整度对应为
`complete / partial / missing`。`partial` 表示已经取得足以形成有效报告的 Facts 或 Observations，同时
明确知道缺了什么、为什么缺、哪些结论不能支持。它是正常完成状态，不是把未知伪装成健康。

面向使用者，一次 Collect 最终归为三类：**完整成功**表示请求范围内的证据充分且产物已交付；
**部分成功**表示已有可用产物，但 Coverage 明确不完整；**失败**表示没有形成可用证据，或产物交付失败。
部分成功既可能来自现场限制（权限、目标状态、时间窗口或采样预算只允许取得一部分），也可能来自用户
在确认环节主动缩小采集范围。后者不是执行错误，但仍必须如实记录为用户选择导致的证据缺口，不能把
较小范围包装成完整证据。

Evidence Bundle 同时保存原始输出、步骤和结构化状态。固定证据面使用 Worksheet 预声明 Outcome，
每格只填一次；完整取得记为 `ok`，部分取得记为 `partial`，访问失败、前置不可用和已证明无需取得分别
记为 `failed / unavailable / unnecessary`。收尾仍未填的格子必须 settle 为明确缺失原因。

### Trace、Log、Metric 是三个基本可观测数据面

Doctor Collect 把 OpenTelemetry 的三类基本信号作为正交证据面：Trace 解释一次请求跨 Service 的因果与
耗时分布，Log 保留离散业务事件和错误上下文，Metric 描述一段时间内的总体趋势与资源/业务指标。三者
可以通过 `trace_id` 和时间窗口对齐，但不能互相代替；CPU 不高也不能据此推断首 token 延迟正常。

`doctor perf` 不另造采集协议。它负责产生刺激、封口压测窗口，并从请求 Outcome 中保留 Plugin 声明的
`trace_id` / `message_id` 等关联键；窗口内调用现有 `doctor metric`，结束后把代表请求的业务 ID 交给
既有 `traceId` resolver，再调用现有 `doctor trace` 和 `doctor log`。
某个数据面因权限、保留期或现场部署缺失时，已取得的其它证据仍应交付，并把整体 Coverage 标为
partial，而不是把缺数据解释为系统健康。

## 流程

Core 统一驱动三段式生命周期；Plugin Service 只注册 Inspect、Probe、Detector contribution，不自行推进
阶段，也不接管 Render、Delivery 或 Cleanup。

1. **Prepare**：合并 CLI、profile 与交互输入，确定目标身份和本轮选中的 Core / Plugin Service
   contribution；建立 port-forward、临时文件等访问条件，并登记其清理责任。
2. **Execute / Inspect**：`runCollect` 统一驱动自身 Inspect 与选中 Plugin Service 注册的 Inspect
   contribution；底层 `runInspects` 按依赖取得 Facts，每个 Fact 一经取得便在本轮后续只读。Core 按诊断目标
   生成 Query，将返回数据保存为 Facts；Relation 作为 Fact 的一种保留已确认的 Identity 关系；没有业务
   Inspect contribution 的 Command 可跳过此步。需要在长 Probe 前保留阶段证据时，Core Command 可通过
   `checkpointFacts` 持久化完整的冻结 Facts；checkpoint 不采集或修改 Facts，也不构成新的 Execute 阶段。
3. **Execute / Probe**：全部 Inspect 完成并深冻结 Facts 后，`runCollect` 才调用 `planProbes(facts)`；Core
   对已收敛 Facts 建立完整公共投影，将同一份 Facts 注入 Core Probe 与选中 Plugin Service 注册的 Probe
   contribution，再驱动它们产生 Observations；当前不按
   Service、producer 或 kind 过滤。单项现场访问失败只影响对应 Coverage，独立 Probe 继续执行。
4. **Execute / Detector**：Evidence Builder 组合 Inspect Facts、Contribution Facts（含 Relation）与 Observations；
   Core 驱动自身通用 Detector 与本次选中 Plugin Service 注册的纯 Evidence Detector，形成 Findings，Coverage
   记录证据缺口。
5. **Finalize**：Renderer 只消费 Diagnosis 与产物元数据，随后统一完成 HTML、Markdown 或 Bundle 的
   Delivery，并执行本轮 Cleanup。

`runInspects`、`runProbes` 与 `runDiagnosis` 是 Collect engine 的低层实现入口；新增领域 Command 必须通过
`runCollect` 进入 Execute。所有领域 Command 已完成迁移，架构测试禁止 `collect/<domain>` 直接调用这些
低层 runner；它们只由 `collect/engine.ts` 组合。

Facts、Config 和执行态 Ctx 必须分开：Facts 不保存密码、原始 DSN 或 Probe 运行结果；带凭据 Target
只存在于本轮 Ctx，进入 manifest 和 Detector 前使用领域脱敏投影。Detector 可以读取 Evidence 中领域
显式选择的 Facts 解释证据为何缺失，但不能追加 I/O。
进入 Service Detector 的 Fact、Observation 与 Finding 使用 `kind + schemaVersion` 标识数据契约，并携带
Core 规范化的 producer provenance；Plugin kind 的命名空间由 Core 补充，Detector 不接收未限定来源的
Plugin schema。

## 关键设计

### 完成状态不由单个 Probe 决定

Probe 的 `onFailed` 是现场失败的显式降级契约。声明它表示 runner 可以把异常记录为证据缺口并继续；
未声明时异常仍向上抛，因为依赖成环、重复记账、解析不变量被破坏等 Doctor 自身错误不能伪装成
partial。依赖 Probe 除 Observations 外还会收到上游的状态和原因，以便把失败准确投影为 unavailable，
而不是误判成 unnecessary。

同一 Probe 的多个 `ProbeStrategy` 表示取得同一种 Observation 的升级链。策略返回发生了什么以及是否
继续；runner 不替领域猜测失败后是否值得升级。`dependsOn` 只描述真实数据依赖，`targetAccess` 表达
整条策略链可能产生的最大影响。

### Coverage、交付与退出码分开

默认退出规则如下：

| 命令终止 | Evidence | 交付 | 退出码 |
|---|---|---|---:|
| 正常 | complete | 成功 | 0 |
| 正常 | partial | 成功 | 0 |
| 正常 | missing | 任意 | 1 |
| 正常 | complete / partial | 失败 | 1 |
| 参数错误 | - | - | 2 |
| 用户取消 | - | - | 130 |

退出码 `0` 表示 Doctor 正常形成并交付了一份可用产物，不表示 Target 健康，也不表示证据完整。自动化若
关心完整度，应读取报告或 Evidence 中的 Coverage，而不是把所有非完整情况都折叠成进程失败。

### Partial 仍交付用户请求的报告

Partial 报告沿用用户请求的 HTML、Markdown 或 Bundle 格式，并必须展示：已取得的证据、失败或不可用
步骤、缺失原因、Coverage 以及不能支持的结论。非零退出码不应直接决定产物类型；完全无法形成有效
诊断、Renderer 失败或产物写入失败时，才使用失败 Evidence Bundle 兜底。

时间或样本预算耗尽时，报告应保留已采样部分和实际停止原因；用户拒绝某个可选采集面时，应把对应
步骤记为 skipped、对应目标 Coverage 记为不充分。只要其它证据仍足以形成可用报告，两者都按 partial
正常交付，而不是丢弃已有结果或返回失败。

报告保持单文件、离线可读。公共 output 只拥有 shell、通用表格/图表和交付格式；领域 Renderer 决定
章节顺序、文案与数据口径，不从 Markdown 文案反解析结构化数据。

### 副作用与授权

| mode | 含义 |
|---|---|
| `observe` | 不主动改变业务进程或 Pod 状态 |
| `overhead` | 允许 profiler、handler 等受控诊断负担 |
| `disrupt` | 允许安装、注入、临时容器、rollout 或产生持久业务数据的主动负载等显式影响 |

mode 是副作用上限，不是 blanket approval。Operation 描述 `risk / target / impact / steps`，具体执行与
清理由 Probe 或 Provision 工作流拥有。授权发生在动作真正需要执行时；用户拒绝只终止依赖该 Operation
的 Strategy，不应吞掉其它只读证据。
