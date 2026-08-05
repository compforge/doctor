# Collect 共享协议

## 理念 / 概念

Collect 的目标是形成一份诚实、可复查的诊断产物，而不是要求每个外部访问都成功。一次运行由三个
正交维度描述：命令是否正常终止、诊断证据覆盖是否充分、请求的产物是否成功交付。Target 中是否存在
critical Finding 是诊断结论，不属于命令成功语义。

Coverage 分为 `sufficient / partial / insufficient`；跨领域的 Evidence 完整度对应为
`complete / partial / missing`。`partial` 表示已经取得足以形成有效报告的 Facts 或 Observations，同时
明确知道缺了什么、为什么缺、哪些结论不能支持。它是正常完成状态，不是把未知伪装成健康。

Evidence Bundle 同时保存原始输出、步骤和结构化状态。固定证据面使用 Worksheet 预声明 Outcome，
每格只填一次；完整取得记为 `ok`，部分取得记为 `partial`，访问失败、前置不可用和已证明无需取得分别
记为 `failed / unavailable / unnecessary`。收尾仍未填的格子必须 settle 为明确缺失原因。

## 流程

1. 配置确认合并 CLI、profile 与交互输入，确定目标身份，但不创建临时访问资源。
2. preparation 建立 port-forward、临时文件等访问条件，并拥有其清理生命周期。
3. `runInspects` 按依赖取得初始 Facts；Facts 在本轮后续只读。
4. `runDiagnosis` 调度 Probes。Probe 产生 Observations；单项现场访问失败只影响对应 Coverage，独立 Probe
   继续执行。
5. Evidence Builder 组合 Facts 与 Observations，纯 Detector/Coverage 形成 Findings 和证据缺口。
6. Renderer 只消费 Diagnosis 与产物元数据，按用户请求交付 HTML、Markdown 或 Bundle。

Facts、Config 和执行态 Ctx 必须分开：Facts 不保存密码、原始 DSN 或 Probe 运行结果；带凭据 Target
只存在于本轮 Ctx，进入 manifest 和 Detector 前使用领域脱敏投影。Detector 可以读取 Evidence 中领域
显式选择的 Facts 解释证据为何缺失，但不能追加 I/O。

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

报告保持单文件、离线可读。公共 output 只拥有 shell、通用表格/图表和交付格式；领域 Renderer 决定
章节顺序、文案与数据口径，不从 Markdown 文案反解析结构化数据。

### 副作用与授权

| mode | 含义 |
|---|---|
| `observe` | 不主动改变业务进程或 Pod 状态 |
| `overhead` | 允许 profiler、handler 等受控诊断负担 |
| `disrupt` | 允许安装、注入、临时容器或 rollout 等显式变更 |

mode 是副作用上限，不是 blanket approval。Operation 描述 `risk / target / impact / steps`，具体执行与
清理由 Probe 或 Provision 工作流拥有。授权发生在动作真正需要执行时；用户拒绝只终止依赖该 Operation
的 Strategy，不应吞掉其它只读证据。
