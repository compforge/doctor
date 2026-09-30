# Doctor Chat 与共享 Agent

## 理念 / 概念

`doctor chat` 只有一套交互语义，但模型来源与执行位置选择分开。默认由 CLI 在进程内
运行 `packages/agent`；只有显式 `--server`（或使用已记录的远端 conversation ID）才通过 profile 的
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
      └─ --server [--resume] ─► ServerAgent ──► doctor-server SSE

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

`packages/agent` 使用 Pi `AgentHarness` 承接模型循环、持久化、上下文压缩、重试与取消；注入 Skill 和
`read`/`bash` 工具，并投影为 Doctor 语义 block 和
AgentUE patch 输出。宿主负责 Plugin 解析、模型凭据、Pi `ExecutionEnv` 和 conversation 生命周期：
本地 chat 由 CLI 提供这些能力，server chat 由 server interface 提供。chat-tui 只消费 AgentUE 投影，
不直接依赖 pi。

本地 chat 的模型解析保持明确优先级：完整的 `profile.llm` 是用户显式选择，直接使用；
否则消费共享 Model Capability 的 tenant directory 和 model catalog，只展示 `type=llm` 的候选项，
embedding、rerank 和 audio 不进入 chat 选择。选中结果只在当前 Session 生效，不回写 profile。
Plugin inference 持有路由与凭据，CLI 把它适配为 Pi 的 OpenAI-compatible streaming transport；Agent
不需要看到 Plugin 的访问凭据。
`bash` 工具调用在转录中展示实际命令和输出；模型或 server 返回 thinking 文本时，转录用独立 thought block 展示，
不合成未返回的思考内容。profile 的 `llm.thinking` 决定本地模型请求是否启用推理。
Core 在启动 Agent 前完成 Kubernetes access 预检并建立 inference port-forward，连接随
Session 保持，并在 Session 结束时回收。

本地 CLI 将所选 profile 的基础设施目标作为会话默认值写入 Agent prompt 和宿主中立的 `TARGET_*`
shell 环境。profile 在一次 Chat 会话中保持不变；Skill 可按用户指定的环境，为单次工具调用传入另一组
kubeconfig、context 和 namespace。Core 注入的目标字段优先于 Plugin 的 `prepareSkillContext`，后者仍可准备
OpenSearch、DB 等业务访问事实。具体环境名称由 Skill 解析，Core 只接收通用目标参数。
`~/.doctor/config.yaml` 可以缺失；未配置 kubeconfig 时，Doctor 使用 `KUBECONFIG` 或
`~/.kube/config`，并在访问前验证目标。

本地宿主还可以声明 Agent 可调用的 Distribution。每次会话启动时，宿主将声明写入临时 JSON，
生成同名命令入口并加入 Agent 执行环境的 PATH；Skill 直接调用该名称即可。入口调用当前 Doctor，
通过 `--distribution` 加载 JSON，并继承本次已选 profile、配置文件与目标参数。Agent 释放执行环境后，
宿主清理命令入口。工具调用显式传入的目标参数覆盖入口默认值；远端 Chat 的命令入口由实际运行 Agent 的
server 宿主准备。

Skill 可按需读取 `TARGET_*` 默认访问事实；宿主提供的 CLI 命令入口也继承这些默认值。
Doctor 不要求 Skill 识别宿主身份。

### 本地会话文件

本地 Chat 默认按工作目录保存到 `~/.doctor/sessions/`，`DOCTOR_HOME` 可替换 `.doctor` 根目录，
`--session-dir` 可指定会话根目录。每次普通启动创建新会话；`--continue`（`-c`）继续当前目录最近
会话，`--resume`（`-r`）选择历史会话，`--session <path|id>` 打开指定会话。`--no-session` 使用
临时会话，退出后不能恢复；Chat 的配置路径使用完整参数 `--config`。

CLI 创建 Pi 0.87 的 `JsonlSessionRepo` 会话并交给 `AgentHarness`；临时模式使用 Pi 的内存会话。
Harness 负责消息、工具结果、压缩摘要与运行状态的事务写入，Doctor 不再订阅消息自行追加。界面和
导出读取完整消息记录，模型上下文由 Harness 按压缩记录重建。保存失败显示错误，原生存储故障后
不能继续执行；退出等待运行结束并关闭会话。进程被强制终止时，未完成的流式回复不保证保留。
恢复时通过 Pi 中断上次未完成运行，展示提示并等待用户的新输入，不自动重跑可能已执行的 shell 命令。
文件包含实际聊天和工具内容，以当前用户可读写的权限保存，不记录模型配置密钥。

`--fork <path|id>` 使用 Pi 原生 `JsonlSessionRepo.fork(scope=tree)` 派生独立会话：新 ID 和文件，
保留完整消息、工具结果及压缩记录，记录父会话 ID；不复制待执行操作或累计 usage，不改写源会话。
路径、完整 ID 或唯一 ID 前缀沿用会话选择规则，工作目录、profile 和 Plugin 精确版本仍须匹配。
`--fork` 与 `--continue`、`--resume`、`--session`、`--no-session`、`--server` 互斥；
派生后 `/new` 或 `/resume` 按常规切换，不再次执行启动时的 fork。

`/session` 显示文件路径与统计；`/export [file.html|file.jsonl]` 导出已完成的记录，默认在当前目录
生成 HTML，已有目标不覆盖。HTML 提供离线阅读，JSONL 保留 Pi 原始记录。`/new` 新建会话，
`/resume` 在交互界面选择历史会话。恢复同时重建模型上下文和界面历史，不重新执行历史工具。
工作目录、profile 或 Plugin 精确版本不匹配时拒绝恢复，避免旧上下文在不同的执行环境中被误用。

远端会话继续使用 doctor-server 持久化，以 `--server --resume [conversation-id]` 恢复；已有
`state.yaml` 中的显式远端 ID 仍可直接使用 `--resume <id>`。不带 ID 的 `--resume` 默认选择本地
会话。远端会话不使用这些本地保存/导出参数。

### 上下文压缩

Pi `AgentHarness` 根据模型窗口与预留 tokens 自动压缩；遇到可识别的 context overflow 时由 Pi
压缩后重试。`/compact [说明]` 可在空闲时手动压缩，支持中断；界面展示压缩开始、完成或失败，
恢复后的模型请求使用摘要和保留的近期消息，JSONL/HTML 仍包含完整聊天。压缩不改变 profile、
Plugin 或工具权限。模型请求（包括摘要）统一通过宿主提供的模型访问通道。

直接配置的模型使用 `llm.context_window` 和 `llm.max_tokens`（正整数）；Plugin 模型目录的
`contextLength` 支持整数和 K/M 后缀。未提供有效窗口信息时，兼容默认仍为 128000 tokens，
这只是预算假设，应按实际模型填写。输出预算默认取 32000 与窗口四分之一中的较小值；显式
`max_tokens` 必须小于窗口。压缩预留默认不超过 16384 tokens，近期保留预算不超过 20000 tokens，
两者也分别限制在模型窗口四分之一内。

```yaml
llm:
  provider: openai
  endpoint: https://your-model-endpoint/v1
  api_key: your-key
  model: your-model
  context_window: 128000
  max_tokens: 16000
```

Doctor 的 `Session` 只持有界面状态与用户输入队列；Pi 的会话记录是模型上下文和运行状态的
唯一持久化来源。已有 JSONL/续聊能力与 Harness 在同一未发布版本中交付，不兼容早期开发分支
使用的 Pi 0.84 JSONL 布局。

### Skill 跟随 Plugin

Skill 不拥有独立的安装、选择、信任或升级生命周期。Plugin 切换或版本变化时必须新建 conversation，
避免旧上下文继续依据另一版 Skill 推理。Plugin loader 交付 Skill 内容及 `SKILL.md` 的绝对路径；Pi
只在 prompt 中暴露元数据和路径，由 Agent 通过 `read` 按需加载完整指令，并用同一执行环境读取引用、
运行脚本。Doctor 没有独立的 Skill 读取工具或资源协议。

### 安全来自能力边界

提示词不能替代权限。Pi `ExecutionEnv` 是文件与进程执行抽象，不是安全沙箱；本地 `read`/`bash` 继承
Doctor 进程权限。readonly profile 必须与只读 kubeconfig、DB 用户和最小 RBAC 一致；共享 Agent 使用的
Kubernetes 或数据库工具由宿主落实作用域、超时、容量和审批策略。

readonly 工具策略与本地执行沙箱属于明确的后续安全能力，见 [`backlog.md`](backlog.md)。

## References

- `../cli/docs/kernel.md` — CLI 分层、Doctor Host/Target 与确定性诊断边界
- `../cli/docs/plugin.md` — Plugin 安装、精确版本选择与 Skill 分发
- `../cli/docs/naming.md` — Session/Controller 的内外命名规则
