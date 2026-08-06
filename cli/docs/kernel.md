# CLI Kernel

## 理念 / 概念

CLI kernel 定义命令入口、能力准备、确定性诊断和问答交互之间的稳定边界。各链路共用底层能力，
但不共享业务流程：

- `app` 是 composition root，解析用户输入并注入 Plugin 与基础设施能力；
- `command` 持有 collect/provision 共用的启动事实、目标解析和审批契约；
- `provision` 承载 image 发布、debug environment 创建和目标工具安装等显式状态变更；
- `collect/<domain>` 拥有一次确定性诊断的配置、Facts、Probes、Detectors 和交付；
- `packages/agent → chat/Session → chat/Controller → chat-tui` 是独立的问答链路，不依赖 collect；
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
├── chat/                AgentUE model、Session/Controller 与旧 Server 协议 adapter
├── plugin/              Plugin 宿主侧的选择、上下文与加载边界
├── command/             启动检查、Kubernetes 目标解析、执行上下文与审批契约
├── provision/           image、debug environment 与目标工具准备
├── protocol/            CLI ↔ doctor-server 协议与 SSE client
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

packages/agent/          本地 chat 当前使用、未来 server 复用的 Agent、Skill 输入与 AgentUE 输出
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
server 内的工具执行细节搬回 CLI。本地模式当前由 `packages/agent` 实现；现有远端模式通过兼容 adapter
对齐 AgentUE 交互语义。`server` 只声明 endpoint，不隐式改变运行位置；未来 TypeScript server 复用
`packages/agent` 并提供自己的 interface。

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
命令应声明自己真正消费的最窄业务契约：例如 `doctor trace` 和 `doctor log` 消费规范 `trace_id`，因此
依赖 `service.traceId`，而不是借用宽泛的 `service.data` 或在 OpenSearch 中猜测业务 ID 语义。

```text
Command requirements
├── Plugin capability      业务目标、数据来源与语义
├── Core access contract   Host/Target/Kubernetes 访问条件
└── Operation              副作用上限与用户授权
```

访问检查按实际阶段惰性发生，不能以命令可能使用的最大权限提前阻断低能力路径。例如 `doctor debug` 已有
可复用 debug container 时不需要 `update pods/ephemeralcontainers`；只有确实需要注入时才检查该权限。

### 业务型、基础设施型与混合型命令

Collect command 按诊断算法和数据语义的所有者分为三类。这个分类用于判断 Core 与 Plugin 的职责，
不是目录拆分规则；同一个命令可以先消费业务 capability，再进入标准基础设施诊断。

| 类型 | 典型命令 | Plugin 负责 | CLI Core 负责 |
|---|---|---|---|
| 业务型 | `data` | 定位业务 Service，自行访问 Kubernetes/HTTP/DB，执行固定业务查询并返回约定结果 | 触发 capability，编排 Evidence、Detector/Coverage 和展示 |
| 基础设施型 | `store`、`mem`、`net` | 按需贡献目标身份、连接配置或默认选择，不实现通用基础设施诊断 | 执行标准探测与分析，控制风险、资源生命周期和证据交付 |
| 混合型 | `trace`、`log`、`config`、`model`、`mcp` | 处理业务入口、私有 schema 和目标投影 | 消费规范目标后执行通用采集、协议分析和报告 |

Kubernetes 的分工遵循同一所有权：Core 注入当前 profile 选定的 kubeconfig、context、namespace、Service
身份，并提供 port-forward 等需要统一回收的便利能力；Plugin 是同进程受信任代码，可以自行定位 Pod、
读取运行时配置和访问其它资源。Core 不预先读取 selector、Pod、container 或 env 再回传给 Plugin。
只有 Kubernetes 操作本身属于 Core command 时，例如 `log` 读取 Pod 日志、`mem` 操作目标进程，Core 才
负责定位和操作对应 Target，并声明实际需要的 access contract。

混合型命令按阶段保持边界。例如 `trace` 先由 Plugin 把业务 ID 解析为规范 `trace_id` 并贡献
OpenSearch 目标，再由 Core 按 OTel/Jaeger 语义下载和分析 span；`config` 的 Deployment env 由 Core
采集，租户配置等业务数据由 Plugin 取得。`collect` 不因上述分类拆成 `biz/infra` 两套框架。

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

Provision 当前不引入统一 engine。image、debug、install 各自拥有检查、授权、执行和验证流程，只共享
`CommandContext`、terminal 交互和 infra 原语；等真正稳定的共同流程出现后再上提。

### 依赖方向与领域所有权

`app` 可以组装 Plugin、`provision`、`collect` 和 `infra`；`provision` 与 `collect` 互不依赖。共同启动
上下文、Kubernetes 目标解析和审批模型归 `command`，交互归 `terminal`，执行原语归 `infra`。
`packages/agent` 与 `packages/plugin` 不依赖 CLI，具体 Plugin 只依赖 Plugin 公共包；CLI infra 不知道业务
Service、表关系和诊断结论。Plugin loader 把当前精确 Plugin 版本的 Skills 解析后交给本地 Agent，Agent
不扫描独立的 Skill 目录。

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
不直接解释 pi 或 server wire 字段。旧 doctor-server schema 由兼容 `ServerAgent` 收口。

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
