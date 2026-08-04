# AGENTS.md

## 项目定位与边界

CompForge Doctor 是以本地 `doctor` CLI 为中心、面向私有 Kubernetes 环境的开源诊断工具。
CLI 负责确定性采集、证据编排与报告交付；产品知识和私有 Service 访问规则不进入本仓，通过
Plugin 协议由使用方独立实现和分发。

本仓只包含通用 CLI 与 Plugin SDK，不包含任何企业内部 server、业务 Plugin、Skill、环境配置或
私有部署信息。

## 代码地图与核心模块

| 目录 | 角色 |
|---|---|
| `cli/` | Doctor CLI：命令入口、诊断编排、通用 infra、Evidence 与报告 |
| `packages/plugin/` | `@compforge/doctor-plugin`：Plugin、Service Catalog 与 capability 公共协议 |

更细的 CLI 分层与诊断领域索引见 `cli/AGENTS.md`。

## 关键约定

1. **业务与通用能力分离**：业务 Service 名称、拓扑、查询和判读规则只存在于外部 Plugin；CLI 与 SDK
   不依赖具体产品实现。
2. **Plugin 是受信任扩展，不是沙箱**：Doctor 注入当前 profile、Kubernetes 目标和可选 port-forward；
   Plugin 自行决定如何访问服务并按协议返回数据。
3. **确定性诊断以 Evidence 为结果**：采集阶段允许受控的临时准备，Detector 与 Render 只消费已取得
   的 Facts/Observations，不继续访问外部资源。
4. **默认安全边界显式化**：外部访问应声明超时、容量与权限；有副作用的操作必须在执行前展示并确认。

## References

- `cli/AGENTS.md` — CLI 定位、分层与诊断能力地图
- `cli/docs/kernel.md` — CLI 核心分层、Collect/Evidence 与授权契约
- `cli/docs/plugin.md` — Plugin capability、上下文、分发与信任边界

