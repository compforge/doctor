# Doctor Chat 与共享 Agent

## 理念 / 概念

`doctor chat` 只有一套交互语义，profile 只决定 Agent 的运行位置。配置 `server` 时，CLI 通过远端
adapter 取得事件；未配置 `server` 且 `llm` 完整时，CLI 在进程内运行 `packages/agent`。本阶段只落地
本地消费方，`server/` 保持目录占位；未来 TypeScript server 复用同一 Agent 实现。

AgentUE 表达 Agent 产出的语义 model/patch，chat-tui 表达 UI 快照与用户 intent。Doctor 的 `Session`
持有一次 TUI 进程内的 turn、队列和投影状态；`conversation` 表示可持久化的 LLM 记忆，两者不混用。

Skill 是 Plugin 的版本化资源。Profile 选择精确 Plugin 版本后，Plugin loader 把已经解析和校验的
`PluginSkill` 附到 runtime `PluginDefinition`，CLI 再交给 Agent；Agent 不扫描全局 Skill 目录，也不
解释 Plugin 的安装布局。

## 流程

```text
doctor chat
  └─ profile routing
      ├─ server configured ──► ServerAgent ──► doctor-server SSE
      └─ llm configured ─────► @compforge/doctor-agent

Agent source ──► AgentUE patch ──► Session ──► Controller ──► chat-tui / OpenTUI
                                      ▲               │
                                      └──── intent ───┘

Profile ──► exact Plugin version ──► resolved Skills ──► shared Agent
```

现有 doctor-server 的 wire event 只存在于兼容 `ServerAgent` 内，不能反向进入 `packages/agent`。未来
TypeScript server 通过自己的 interface 使用共享 Agent，不在本阶段实现。

## 关键设计

### Agent 共用，宿主能力注入

`packages/agent` 拥有 pi 驱动的模型循环、Skill 按需读取、Doctor 语义 block 和 AgentUE patch 输出。
当前由 CLI 提供 Plugin 解析、模型凭据和 conversation 生命周期；未来 server 提供自己的 interface、
凭据、工具、workspace 与持久化 adapter。chat-tui 只消费 AgentUE 投影，不直接依赖 pi。

### Skill 跟随 Plugin

Skill 不拥有独立的安装、选择、信任或升级生命周期。Plugin 切换或版本变化时必须新建 conversation，
避免旧上下文继续依据另一版 Skill 推理。Agent 只消费结构化 Skill 输入；资源路径校验和读取能力由
Plugin loader 收口。

### 安全来自能力边界

提示词不能替代权限。readonly profile 必须与只读 kubeconfig、DB 用户和最小 RBAC 一致；未来 shell、
Kubernetes 或数据库工具进入共享 Agent 前，需要在宿主 runtime 落实作用域、超时、容量和审批策略。

## References

- `../cli/docs/kernel.md` — CLI 分层、Doctor Host/Target 与确定性诊断边界
- `../cli/docs/plugin.md` — Plugin 安装、精确版本选择与 Skill 分发
- `../cli/docs/naming.md` — Session/Controller 的内外命名规则
