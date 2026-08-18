# AGENTS.md

## 项目定位与边界

Doctor 是以本地 `doctor` CLI 为中心的开源业务诊断工具。在产品心智上，它是面向业务的增强版
`kubectl`：`kubectl` 以 Kubernetes Resource/Object 为操作对象，Doctor 以业务 Service 为基本诊断
粒度；Pod、Container 与 Process 是 Service 下的运行目标和证据来源。Service 通过 capability 声明
可提供的诊断数据或动作，以及运行该能力所需的目标数据和 access。CLI 负责确定性采集、证据编排、
报告交付和本地 agent 问答。业务知识和私有 Service 访问规则不进入本仓，通过 Plugin 协议由使用方
独立实现和分发。

本仓包含通用 CLI、可复用 Agent、Plugin SDK、业务中立的示例 Plugin，以及可选 Doctor server 的宿主
边界；不包含任何企业内部 server、业务 Plugin、Skill、环境配置或私有部署信息。

## 诊断能力模型

Doctor 的诊断范围从通用信号逐步深入到业务语义：先覆盖 Trace、Metric、Log 三类可观测性信号，再
观察 CPU、内存、网络等运行时状态；业务侧通过 capability 补充 data、config、store 等领域事实，
必要时以受控 HTTP 或协议调用主动复现问题。只在压力下出现的问题归 Perf 施压与同窗口信号关联，
Model、MCP 等业务特有领域仍复用同一套 Service 与 capability 模型。

`image`、`debug`、`install` 负责显式准备上述诊断所需的镜像、临时环境和工具。确定性问题由 Core 的
通用能力与 Plugin 的业务 capability 协作形成 Evidence 和报告；无法预先固化路径的开放式问题交给
Doctor Chat，由通用 Agent runtime 使用当前 Plugin 随版本交付的 Skill。

## 代码地图与核心模块

| 目录 | 角色 |
|---|---|
| `cli/` | Doctor CLI：命令入口、诊断编排、通用 infra、Evidence 与报告 |
| `toolkit/` | 独立版本的诊断工具、debug image 与离线系统包；按执行位置的 OS/arch 分发 |
| `server/` | 可选 Doctor server 的宿主边界 |
| `packages/agent/` | `@compforge/doctor-agent`：供 CLI 与 server 宿主共用的 agent loop、Skill 输入和 AgentUE 输出 |
| `packages/plugin/` | `@compforge/doctor-plugin`：Plugin、Service Catalog 与 capability 公共协议 |
| `plugins/example/` | 只演示协议接入的业务中立 Plugin |

更细的 CLI 分层与诊断领域索引见 `cli/AGENTS.md`。

## 关键约定

1. **Core/Plugin 以 capability 为中心**：capability 是 Core 发现和消费 Plugin 能力的入口；access、
   类型化 data、Target-scoped infra 与 profile config 只支撑 capability 的准备和调用，不形成平行的
   扩展生命周期。私有业务实现不进入 CLI/SDK。
2. **Plugin 是 Service 与 Skill 的分发单元**：一个 Plugin 可打包多个 Service 及多个 Skill；Service
   capability 是业务能力和所需 access 的声明单元，Plugin 不重建 Core 访问层；`plugin@version` 的代码
   与 Skills 内容不可变，任一内容变化都必须提升 Plugin version。
3. **确定性诊断以 Evidence 为结果**：采集阶段允许受控的临时准备，Detector 与 Render 只消费已取得
   的 Facts/Observations，不继续访问外部资源。
4. **默认安全边界显式化**：命令先完成配置、capability、环境与实际 access 准备，再进入领域工作；
   外部访问应声明超时、容量与权限，有副作用的操作必须在执行前展示并确认。
5. **Agent 共用，宿主分离**：CLI 与 server 通过各自的 interface、凭据和执行环境使用同一
   `packages/agent`；Skill 跟随 Doctor Host 当前加载的精确 Plugin 版本，不建立独立安装、选择或升级生命周期。
6. **Core 内容与版本同步演进**：Doctor Core 的代码或非 Markdown 用户可见内容发生变化时，必须在同一
   PR 运行 `make -C cli bump-version` 提升 patch version；纯 Markdown 文档改动无需提升版本。
   `cli/src/app/version.ts` 是唯一版本事实源，运行时、构建产物命名与 Release 都读取该值，不在其它
   文件重复维护版本号。
7. **Toolkit 独立演进**：工具、debug image、离线系统包与兼容性 manifest 归 `toolkit/`，不进入 CLI
   executable；任一交付内容变化都必须提升 `toolkit/VERSION`。平台按资源实际执行位置解析，不能用
   Doctor Host 平台替代 Kubernetes Target 平台。

## References

- `cli/AGENTS.md` — CLI 定位、分层与诊断能力地图
- `cli/docs/kernel.md` — CLI 核心分层、Collect/Evidence 与授权契约
- `cli/docs/plugin.md` — Plugin capability、上下文、分发与信任边界
- `docs/chat.md` — Doctor Chat 数据流、Agent 复用边界与 Plugin Skill 生命周期
