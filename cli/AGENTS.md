# cli AGENTS.md

## 项目定位与边界

Doctor CLI 是本地诊断入口，以 Provision、Collect、Perf 和 Chat 四条并列主路径组织能力准备、
确定性诊断、主动施压和开放式问答；具体业务目标、私有数据位置和数据语义由外部 Plugin 提供。

- **配置与入口**：`doctor init/profile` 管理本地 profile，bare `doctor` 展示当前能力索引。
- **能力准备**：`doctor image/debug/install` 显式改变 Registry、Doctor Host 或 Target 状态。
- **确定性诊断**：各领域命令共用 Collect、Evidence 和风险授权协议，不依赖具体业务实现。
- **主动施压**：`doctor perf` 按共享 Perf Harness 契约产生业务流量，并复用 Collect 取得同窗口证据。
- **开放式问答**：`doctor chat` 默认运行本地 Agent；显式 `--server` 才连接远端，两者共用 AgentUE/chat-tui 交互。
- **Plugin 扩展**：CLI 只负责选择并注入 Plugin；公共契约归 `../packages/plugin`。

## 代码地图与核心模块

| 模块 | 所有权 |
|---|---|
| `app` | 命令入口、profile 与 composition root |
| `chat` | AgentUE model、Session/Controller，以及 Server wire protocol adapter |
| `model` | Chat 与 Model Collect 共用的模型发现、选择和 inference 访问 |
| `command` | 四条主路径共用的启动检查、Kubernetes 目标解析与 access/审批契约 |
| `provision` | 为诊断显式准备 image、debug environment 和工具 |
| `collect` | 确定性诊断共享协议、执行引擎、Evidence 与领域实现 |
| `perf` | 对 Plugin Case 加压、Perf Harness 适配与跨 trace/log/metric 报告 |
| `plugin` | Plugin 宿主侧的选择、上下文与加载边界 |
| `infra` | DB、HTTP、Kubernetes、进程和本机工具等访问原语 |
| `terminal` / `protocol` | 通用终端交互与可选远端协议 client；chat-tui 只消费 `chat` 投影 |

展开的目录地图、依赖方向和领域所有权见 `docs/kernel.md`；Collect 共享协议见
`docs/collect-protocol.md`。

## 关键约定

1. **执行位置属于能力身份**：Doctor Host 承载 CLI 和本地能力，Target 是被诊断对象；非只读动作必须
   在执行前展示位置、对象、真实动作和影响。
2. **Provision 与 Collect 按结果分离**：Provision 的结果是外部状态变化或能力准备；Collect 的结果是
   Evidence，不能演变成隐藏式发布、环境创建或工具安装。
3. **Collect 单向且可复查**：Inspect 形成 Facts，Probe 产生 Observations，再进入 Detector/Coverage 和
   Render；Detector/Render 不访问外部资源。
4. **分层不穿透**：业务目标与私有语义归外部 Plugin，标准基础设施采集与分析归 CLI Core，公共契约归
   `packages/plugin`；命令必须先完成配置、capability、环境和实际 access 准备，再进入领域工作，具体 Plugin
   不能反向依赖 CLI。
5. **Catalog 与运行状态分开**：Catalog 只声明可能提供的 capability；collect 再结合现场环境判断本次
   是否可用。
6. **Case 触发与加压分开**：Plugin case runner 每次只触发一个 Case；Perf/Core 独占并发调度、预算、
   熔断和 Window 归约。
7. **工具与执行通道分开**：根目录 `toolkit/` 只分发版本化资源；CLI `infra/toolkit` 按 Host process、
   Host container 或 Kubernetes container 的实际 OS/arch 选取资源，再交给对应 infra adapter 执行。
   同一 Host 能力同时支持 container 与 process 时，先探测已有且可用的本地 container；不可用才回退
   本机进程。探测本身不隐式 load image 或改变 Host 状态。
8. **可观测性按读者分层**：终端错误通过 stderr 提供面向现场用户的原因、版本、命令、失败阶段和
   技术日志路径；完整异常链与运行上下文进入 Doctor Host 当前目录的 error log，`--debug` 仅在显式启用时
   向 stderr 展开技术详情。诊断记录不得直接写入完整 argv、环境变量或未经脱敏的凭据与协议正文。
9. **默认交付兼顾阅读与完整取证**：诊断命令未指定 `--format` 时，同时交付外置 HTML 和完整
   `tar.gz`；Bundle 解压后只产生一个顶层目录，目录内保留 `report.html`、领域 JSON、原始 Evidence 与附件；
   finalize 在该目录生成 `AGENTS.md`，说明面向人的 HTML 完整路径、证据阅读顺序和不可信 raw 内容边界。
   显式指定已有 format 时只交付该格式，不改变其既有语义。领域 command 只准备并向共享
   `CommandContext` 注册 Artifacts；统一 finalize 阶段负责 Delivery，组合命令不自行复制或压缩子产物。

## References

- `docs/kernel.md` — CLI 核心分层、Collect/Evidence、Doctor Host/Target 与授权契约
- `docs/collect-protocol.md` — Collect 数据流、Probe 调度、部分完成、Evidence 与退出码契约
- `docs/plugin.md` — Plugin capability、上下文、分发与信任边界
- `docs/commands/perf.md` — Perf 主动施压、共享契约与可观测证据编排
- `docs/commands/tenant.md` — Tenant 作用域、通用 contribution 协议与安全报告 IR 边界
- `docs/naming.md` — chat 内部短名与跨边界公开命名约定
- `docs/commands/` — 各 `doctor <command>` 的领域理念、主流程与关键设计
