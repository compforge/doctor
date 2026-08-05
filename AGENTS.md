# AGENTS.md

## 项目定位与边界

Doctor 是以本地 `doctor` CLI 为中心、面向应用与基础设施的开源诊断工具。
CLI 负责确定性采集、证据编排与报告交付；业务知识和私有 Service 访问规则不进入本仓，通过
Plugin 协议由使用方独立实现和分发。

本仓包含通用 CLI、Plugin SDK、业务中立的示例 Plugin，以及未来 Doctor server 的目录占位；不包含
任何企业内部 server、业务 Plugin、Skill、环境配置或私有部署信息。

## 代码地图与核心模块

| 目录 | 角色 |
|---|---|
| `cli/` | Doctor CLI：命令入口、诊断编排、通用 infra、Evidence 与报告 |
| `server/` | 可选 Doctor server 的规划占位，当前没有实现 |
| `packages/plugin/` | `@compforge/doctor-plugin`：Plugin、Service Catalog 与 capability 公共协议 |
| `plugins/example/` | 只演示协议接入的业务中立 Plugin |

更细的 CLI 分层与诊断领域索引见 `cli/AGENTS.md`。

## 关键约定

1. **访问能力与 Plugin 能力分离**：Core 负责如何访问和安全操作 Target；Plugin 负责目标是什么、业务
   数据在哪里以及数据语义，CLI、SDK 和 example Plugin 不依赖具体业务实现。
2. **Plugin 是受信任扩展，不是沙箱**：Doctor 注入当前 profile、Kubernetes 目标和可选 port-forward；
   Plugin 自行决定如何访问服务并按协议返回数据。
3. **确定性诊断以 Evidence 为结果**：采集阶段允许受控的临时准备，Detector 与 Render 只消费已取得
   的 Facts/Observations，不继续访问外部资源。
4. **默认安全边界显式化**：外部访问应声明超时、容量与权限；有副作用的操作必须在执行前展示并确认。

## References

- `cli/AGENTS.md` — CLI 定位、分层与诊断能力地图
- `cli/docs/kernel.md` — CLI 核心分层、Collect/Evidence 与授权契约
- `cli/docs/plugin.md` — Plugin capability、上下文、分发与信任边界
