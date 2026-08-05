# CLI Kernel

## 理念 / 概念

CLI kernel 定义命令入口、能力准备、确定性诊断和问答交互之间的稳定边界。各链路共用底层能力，
但不共享业务流程：

- `app` 是 composition root，解析用户输入并注入 Plugin 与基础设施能力；
- `command` 持有 collect/provision 共用的启动事实、目标解析和审批契约；
- `provision` 承载 image 发布、debug environment 创建和目标工具安装等显式状态变更；
- `collect/<domain>` 拥有一次确定性诊断的配置、Facts、Probes、Detectors 和交付；
- `protocol → app/session → tui` 是独立的问答链路，不依赖 collect；
- `packages/plugin` 定义 Plugin、Service 与 capability 公共协议，`plugins/<plugin>` 持有访问实现与固定业务查询；
  `infra` 只提供 Doctor 的外部资源访问能力。

确定性诊断的核心不是“执行一组命令”，而是生成可复查的 Evidence：

```text
Config → target confirmation → preparation → Inspect → Facts ─┬→ Probe → Observations ─┐
                                                               └─────────────────────────→ Evidence
                                                                                            ├→ Detector → Findings
                                                                                            ├→ Coverage
                                                                                            └→ Render
```

| 概念 | 稳定语义 |
|---|---|
| Config | flags/profile/交互输入形成的用户意图，不进入 Facts |
| Inspect / Facts | 行动前的只读现场快照；每个子 Fact 显式标记取得状态 |
| Probe / Observation | 一次受限采集行动，以及它产生的结构化数据 |
| Evidence | 交给 detector 的 Observations 与领域显式挑选的 Facts |
| Finding / Coverage | 基于证据的确定性判断，以及诊断目标的证据充分度 |
| Operation | 需要授权的副作用描述，本身不执行动作 |
| Evidence Bundle | manifest、原始输出和摘要组成的可审计产物 |

## 代码地图

```text
cli/src/
├── app/                 命令入口、profile、会话流程与能力组装
├── plugin/              Plugin 宿主侧的选择、上下文与加载边界
├── command/             启动检查、Kubernetes 目标解析、执行上下文与审批契约
├── provision/           image、debug environment 与目标工具准备
├── protocol/            CLI ↔ doctor-server 协议与 SSE client
├── tui/                 Ink 问答界面
├── terminal/            命令共用的选择、输入、确认与输出边界
├── collect/
│   ├── protocol.ts      Facts、Observation、Finding、Coverage 等共享协议
│   ├── engine.ts        Facts → Probe → Evidence → Detector/Coverage
│   ├── *-engine.ts      Inspect、Probe 与 Strategy 调度
│   ├── evidence.ts      Worksheet 与 Evidence Bundle
│   ├── operation.ts     副作用授权和审计
│   ├── output/          Bundle、Markdown、HTML 等交付
│   └── <domain>/        领域 config/fact/probe/detector/render
└── infra/               Host、Target、K8s 与各类外部资源 adapter

packages/plugin/         Plugin、Service Catalog 与 capability 公共协议
plugins/<plugin>/        具体 Plugin 的 Catalog、领域模型与固定业务查询
```

目录按真实职责生长，不为概念对称提前创建空层。跨领域 Fact、Probe 或 infra 只有出现稳定、同语义的
重复时才上提；表面相似但诊断口径不同的逻辑继续留在各自 domain。

## 运行形态与执行位置

profile 决定 CLI 能呈现的能力，而不是让不同执行模型互相渗透：

| profile 条件 | 能力形态 |
|---|---|
| 零配置 | 使用本地 kubeconfig 的确定性诊断 |
| 配置 `llm`、未配置 `server` | 本地轻量问答（规划中） |
| 同时配置 `llm` 与 `server` | 连接 doctor-server 的完整 agent runtime |

direct collect 不创建 connection、conversation 或 SSE，也不承担开放式 agent 推理；server mode 不把
server 内的工具执行细节搬回 CLI。两种形态只共享 Doctor 入口和稳定协议。

执行位置属于能力身份：

- **Doctor Host** 是运行 CLI 的工作站或部署机，拥有本地文件、网络入口、container engine 和离线 analyzer；
- **Target** 是本轮被诊断的 Pod、container、进程、远端服务或数据对象；
- Host 与 Target 的文件传输由 `infra/file-transfer` 表达，路径和方向必须显式命名；
- 某侧缺少能力时，错误必须指出缺的是 Host 还是 Target，不能用全局 `available` 混合表达。

Kubernetes 是 Doctor Host 到 Target 的一种访问通道。`app` 先形成 `CommandContext`，各命令再按实际
资源作用域声明 `required` 或 `preferred` access contract：required 被明确拒绝时停止当前阶段；
preferred 被拒绝时进入手动输入或低能力降级；`kubectl auth can-i` 无法判断时保留 `unknown`，由实际
操作给出最终结论。权限上下文按 executor 缓存，但不进入诊断 Facts/Evidence。

命令的前置条件沿两条正交能力轴表达：Core access 描述如何接近和安全操作 Target，Plugin capability
描述目标是什么、业务数据在哪里以及数据语义。Core command 不依赖 Plugin；Plugin command 始终注册，
但在创建 `CommandContext` 和访问 Kubernetes 前先验证当前 profile 已选择 Plugin 且具备 required
capability，缺失时直接说明具体 capability。preferred capability 缺失只触发声明过的降级路径。

```text
Command requirements
├── Plugin capability      业务目标、数据来源与语义
├── Core access contract   Host/Target/Kubernetes 访问条件
└── Operation              副作用上限与用户授权
```

访问检查按实际阶段惰性发生，不能以命令可能使用的最大权限提前阻断低能力路径。例如 `doctor debug` 已有
可复用 debug container 时不需要 `update pods/ephemeralcontainers`；只有确实需要注入时才检查该权限。

## Collect 共享协议

### 单向数据流

1. 配置确认合并 CLI/profile/交互输入，确定目标身份，但不创建临时访问资源。
2. preparation 建立 port-forward、临时文件等访问条件，并拥有其清理生命周期。
3. `runInspects` 按依赖顺序取得初始 Facts；Facts 在本轮后续只读。
4. `runDiagnosis` 调度 Probes，构建 Evidence，再执行纯 Detector 与 Coverage。
5. Renderer 只消费 Diagnosis 和产物元数据，不访问 infra，也不从 Markdown 文案反解析结构化数据。

Facts、Config 和执行态 Ctx 必须分开：Facts 不保存密码、原始 DSN 或 Probe 运行结果；带凭据 target
只存在于本轮 Ctx，进入 manifest 和 detector 前使用领域脱敏投影。Detector 可以读取 Evidence 中领域
显式选择的 Facts，以解释证据为何缺失，但不能借此追加 I/O。

Facts 与 Observations 的边界是取得阶段和访问规则，不是要求同一事实绝不投影两次。若 detector 既需要
行动前状态又需要一次 Probe 的组合结果，领域可以显式投影，但不能把未执行 Probe 的推测伪装成 Observation。

### 缺口驱动与 Probe 调度

构建期从诊断目标反推所需 Fact/Observation，再实现 Probe、Strategy、工具与 Operation；运行期从
Facts、mode、授权、超时和容量预算收敛到本次实际可得的证据。工具不是 Probe，attach/安装/rollout
等前置动作也不是 Observation。

同一 Probe 的多个 `ProbeStrategy` 表示取得同一种 Observation 的升级链：优先已有 dump、只读 API 或
现成工具，只有不可行时才升级到 attach、注入或 rollout。策略返回执行状态和 `stop/continue` 决策，
runner 不替领域猜测“失败后是否值得升级”。`dependsOn` 只描述 Probe 间真实数据依赖；`targetAccess`
表达整条策略链可能产生的最大影响，不能因第一条策略只读就隐去后续风险。

单项失败只降低对应 Coverage，不阻断其它独立 Probe。缺口必须能沿 required evidence → Probe → Strategy
解释为缺工具、目标不支持、权限不足、用户拒绝、预算耗尽或执行失败。

### Evidence、交付与退出码

Evidence Bundle 同时保存原始输出、步骤和结构化状态。固定证据面可通过 Worksheet 预声明 Outcome，
每个格子只填一次，收尾时未填格子必须 settle 为明确缺失原因；即时查询或运行时才发现 id 的命令可使用
纯追加 Step，不为形式统一预印空格。

`evaluateCollectOutcome` 将证据完整性、交付状态和退出码分开：

- 必需证据完整且产物交付成功时退出 `0`；
- 必需证据 partial/missing，或报告/Bundle 交付失败时退出 `1`；
- 用户取消为 `130`，参数错误为 `2`；
- Finding 严重度描述目标健康，不改变退出码。

报告保持单文件、离线可读。公共 output 只拥有 shell、通用表格/图表和交付格式；domain renderer 决定
章节顺序、领域文案与数据口径。多 domain 汇总可以用隔离 Tab 组合各自报告，但不能在 shell 中硬编码
Store、HTTP 等领域语义。

### 副作用与授权

| mode | 含义 |
|---|---|
| `observe` | 不主动改变业务进程或 Pod 状态 |
| `overhead` | 允许 profiler、handler 等受控诊断负担 |
| `disrupt` | 允许安装、注入、临时容器或 rollout 等显式变更 |

mode 是副作用上限，不是 blanket approval。Operation 描述 `risk / target / impact / steps`，具体执行与
清理由 Probe 或 Provision 工作流拥有。授权发生在动作真正需要执行时：高于 mode 直接拒绝；同一
`operation.id@target` 的 gate 决定在一次命令内复用；用户拒绝、非交互、gate 异常和 `--yes` 必须保留
不同来源。拒绝只终止依赖该 Operation 的 Strategy，不应吞掉其它只读证据。

## 关键边界

### Provision 与 Collect

两者都可能执行非只读动作，边界取决于主要结果：Provision 以外部能力准备完成为结果；Collect 以
可审计 Evidence 为结果。Collect 不会为了绕过前置条件隐藏式发布 image、创建 debug environment 或
安装工具；能力不足时说明缺口，由用户独立运行对应准备命令。

Provision 当前不引入统一 engine。image、debug、install 各自拥有检查、授权、执行和验证流程，只共享
`CommandContext`、terminal 交互和 infra 原语；等真正稳定的共同流程出现后再上提。

### 依赖方向与领域所有权

`app` 可以组装 Plugin、`provision`、`collect` 和 `infra`；`provision` 与 `collect` 互不依赖。共同启动
上下文、Kubernetes 目标解析和审批模型归 `command`，交互归 `terminal`，执行原语归 `infra`。
`packages/plugin` 不依赖 CLI，具体 Plugin 只依赖该公共包；CLI infra 不知道业务 Service、表关系和诊断结论。

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
`terminal`。TUI 只依赖 `Session`/`UiEvent`，不直接访问协议 client 或 collect；wire 字段以 server
schema 为准。

Ink history 分为已完成且永久写入 scrollback 的 committed 区，以及当前 turn 内可变的 pending 区，
避免高频 chunk 重算全部历史。第三方 ANSI 文本进入 Ink 前必须剥离或显式 reset；这些是代码级维护约束，
具体组件和依赖以 `tui/` 实现为准，不再维护独立框架调研稿。

### Runtime 与分发

CLI core 只依赖 Node-compatible API，从同一个入口构建各平台单文件。runtime 差异留在 `infra/host`
和构建脚本，collect domain 不直接调用 `Bun.*`。Linux x64 同时提供 modern Bun 与兼容旧 glibc 的
legacy Node SEA；无法证明目标满足 modern 基线时保守选择 legacy。具体版本、文件名、校验和与发布矩阵
以 Makefile、构建脚本和 CI gate 为事实源，不在设计文档复制。

## Domain 文档约定

每个 domain 只维护一篇文档，描述领域理念、主流程和不能从单文件代码看出的关键设计；共享执行协议只在
本文定义，字段、阈值、参数和当前实现形状留在代码。当前 domain 文档：

| Domain | 文档 |
|---|---|
| Config | [`config-diagnosis.md`](config-diagnosis.md) |
| CPU | [`cpu-diagnosis.md`](cpu-diagnosis.md) |
| Data | [`data-diagnosis.md`](data-diagnosis.md) |
| Debug | [`debug-container.md`](debug-container.md) |
| HTTP | [`http-diagnosis.md`](http-diagnosis.md) |
| Image | [`image.md`](image.md) |
| Install | [`install.md`](install.md) |
| Log | [`log-diagnosis.md`](log-diagnosis.md) |
| MCP | [`mcp-diagnosis.md`](mcp-diagnosis.md) |
| Memory | [`memory-diagnosis.md`](memory-diagnosis.md) |
| Model | [`model-diagnosis.md`](model-diagnosis.md) |
| Network | [`network-diagnosis.md`](network-diagnosis.md) |
| Store（DB/VDB/S3/Redis） | [`store-diagnosis.md`](store-diagnosis.md) |
| Trace | [`trace-diagnosis.md`](trace-diagnosis.md) |

新增 domain 时先定义 Facts、Observations、Evidence/Findings/Coverage 和纯 detector，再实现 Inspect/Probe
与 renderer；契约测试至少覆盖依赖调度、能力降级、授权拒绝、敏感信息边界和交付结果。若新增内容只是
共享协议的一个 case，更新本文或代码即可，不再创建横切专题文档。
