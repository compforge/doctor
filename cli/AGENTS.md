# cli AGENTS.md

## 项目定位与边界

Doctor CLI 是本地诊断入口和确定性诊断主体。它负责选择目标、准备受控能力、采集事实、执行规则并
交付 Evidence/报告；具体业务目标、私有数据位置和数据语义由外部 Plugin 提供。

- **配置与入口**：`doctor init/profile` 管理本地 profile，bare `doctor` 展示当前能力索引。
- **能力准备**：`doctor image/debug/install` 显式改变 Registry、Doctor Host 或 Target 状态。
- **确定性诊断**：各领域命令共用 Collect、Evidence 和风险授权协议，不依赖具体业务实现。
- **开放式问答**：`doctor chat` 默认运行本地 Agent；显式 `--server` 才连接远端，两者共用 AgentUE/chat-tui 交互。
- **Plugin 扩展**：CLI 只负责选择并注入 Plugin；公共契约归 `../packages/plugin`。

## 代码地图与核心模块

| 模块 | 所有权 |
|---|---|
| `app` | 命令入口、profile 与 composition root |
| `chat` | AgentUE model、Session/Controller，以及 Server wire protocol adapter |
| `command` | Collect/Provision 共用的启动检查、Kubernetes 目标解析与审批契约 |
| `provision` | 为诊断显式准备 image、debug environment 和工具 |
| `collect` | 确定性诊断共享协议、执行引擎、Evidence 与领域实现 |
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
   `packages/plugin`；具体 Plugin 不能反向依赖 CLI。
5. **Catalog 与运行状态分开**：Catalog 只声明可能提供的 capability；collect 再结合现场环境判断本次
   是否可用。

## References

- `docs/kernel.md` — CLI 核心分层、Collect/Evidence、Doctor Host/Target 与授权契约
- `docs/collect-protocol.md` — Collect 数据流、Probe 调度、部分完成、Evidence 与退出码契约
- `docs/plugin.md` — Plugin capability、上下文、分发与信任边界
- `docs/naming.md` — chat 内部短名与跨边界公开命名约定
- `docs/commands/` — 各 `doctor <command>` 的领域理念、主流程与关键设计
