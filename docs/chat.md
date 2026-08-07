# Doctor Chat 与共享 Agent

## 理念 / 概念

`doctor chat` 只有一套交互语义，但模型来源与执行位置选择分开。默认由 CLI 在进程内
运行 `packages/agent`；只有显式 `--server`（或恢复远端 conversation）才通过 profile 的
`server` 和 `ServerAgent` 取得事件。本地 chat 优先使用 profile 显式配置的 `llm`；未配置时，
从当前 Plugin 的模型目录中选择 LLM，并由 Plugin inference 提供推理访问。CLI 与 server 是两个
宿主，通过各自的 interface、凭据、执行环境和持久化 adapter 使用同一 Agent 实现。

AgentUE 表达 Agent 产出的语义 model/patch，chat-tui 表达 UI 快照与用户 intent。Doctor 的 `Session`
持有一次 TUI 进程内的 turn、队列和投影状态；`conversation` 表示可持久化的 LLM 记忆，两者不混用。

Skill 是 Plugin 的版本化资源。Doctor Host 加载精确 Plugin 版本后，Plugin loader 把已经解析和校验的
`PluginSkill` 附到 runtime `PluginDefinition`，CLI 再交给 Agent；Agent 不扫描全局 Skill 目录，也不
解释 Plugin 的安装布局。

## 流程

```text
doctor chat
  └─ execution choice
      ├─ default ──► model choice ──► @compforge/doctor-agent
      └─ --server / --resume ─► ServerAgent ──► doctor-server SSE

model choice
  ├─ profile.llm ──────────────► direct model endpoint
  └─ no profile.llm ─► tenant + LLM selection ─► Plugin inference

Agent source ──► AgentUE patch ──► Session ──► Controller ──► chat-tui / OpenTUI
                                      ▲               │
                                      └──── intent ───┘

Doctor Host ──► exact Plugin version ──► resolved Skills ──► shared Agent

Profile ──► prompt facts + TARGET_* env ──► NodeExecutionEnv ──► Pi read/bash ──► Skill files and scripts
```

doctor-server 的 wire event 只存在于 `ServerAgent` 内，由它投影为 AgentUE，不能反向进入
`packages/agent`。server endpoint 也不隐式改变执行位置。

## 关键设计

### Agent 共用，宿主能力注入

`packages/agent` 拥有 pi 驱动的模型循环、Skill 按需读取、`read`/`bash` 工具、Doctor 语义 block 和
AgentUE patch 输出。宿主负责 Plugin 解析、模型凭据、Pi `ExecutionEnv` 和 conversation 生命周期：
本地 chat 由 CLI 提供这些能力，server chat 由 server interface 提供。chat-tui 只消费 AgentUE 投影，
不直接依赖 pi。

本地 chat 的模型解析保持明确优先级：完整的 `profile.llm` 是用户显式选择，直接使用；
否则复用 `doctor model` 的 tenant directory 和 model catalog，只展示 `type=llm` 的候选项，
embedding、rerank 和 audio 不进入 chat 选择。选中结果只在当前 Session 生效，不回写 profile。
Plugin inference 持有路由与凭据，CLI 把它适配为 Pi 的 OpenAI-compatible streaming transport；Agent
不需要看到 Plugin 的访问凭据。

本地 CLI 还会把当前 profile 已确定的基础设施目标同时写入 Agent prompt 和宿主中立的 `TARGET_*`
shell 环境。
profile name 就是 Plugin Skill 使用的环境标识（env key 或 alias），profile 配置提供 kubeconfig、namespace 等已解析访问
事实；Core 直接注入 profile-owned target，Plugin 的 `prepareSkillContext` 可继续准备 OpenSearch、DB 等业务访问事实，但不能覆盖 profile
确定的 target。Skill 可以携带完整的多环境台账，但当前会话始终受 profile 约束；环境选择属于宿主和访问
adapter，不要求同一份 Skill 为 Doctor 与其它 Agent 宿主维护不同文案或资源副本。

Skill 侧把这个接缝记作 `resolveInfra(env) -> infra`：`TARGET_*` 注入值优先，未注入字段由 Skill 自带的
env registry 补齐。Doctor 只负责准备访问事实，不要求 Skill 识别宿主身份。

### Skill 跟随 Plugin

Skill 不拥有独立的安装、选择、信任或升级生命周期。Plugin 切换或版本变化时必须新建 conversation，
避免旧上下文继续依据另一版 Skill 推理。Plugin loader 交付 Skill 内容及 `SKILL.md` 的绝对路径；Pi
只在 prompt 中暴露元数据和路径，由 Agent 通过 `read` 按需加载完整指令，并用同一执行环境读取引用、
运行脚本。Doctor 没有独立的 Skill 读取工具或资源协议。

### 安全来自能力边界

提示词不能替代权限。Pi `ExecutionEnv` 是文件与进程执行抽象，不是安全沙箱；本地 `read`/`bash` 继承
Doctor 进程权限。readonly profile 必须与只读 kubeconfig、DB 用户和最小 RBAC 一致；共享 Agent 使用的
Kubernetes 或数据库工具由宿主落实作用域、超时、容量和审批策略。

## References

- `../cli/docs/kernel.md` — CLI 分层、Doctor Host/Target 与确定性诊断边界
- `../cli/docs/plugin.md` — Plugin 安装、精确版本选择与 Skill 分发
- `../cli/docs/naming.md` — Session/Controller 的内外命名规则
