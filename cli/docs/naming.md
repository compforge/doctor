# Chat 命名

## 理念 / 概念

chat 模块内部处于明确上下文中，使用 `Session`、`Controller` 这类短名。不要把目录语义重复进
`DoctorChatSession`、`DoctorChatController`；`Session` 在这里唯一表示一段 TUI 运行期的 turn、队列和
AgentUE model 所有者。

跨模块公开时，名字需要让调用方脱离目录仍能理解。确有冲突时由调用方在 import 处起别名，例如
`import { Agent as LocalAgent } from "@compforge/doctor-agent"`，而不是让内部实现长期背负外部上下文。

## 关键设计

- `Agent` 是 `packages/agent` 中的共享执行实现；兼容远端协议的实现用 `ServerAgent` 表达数据来源。
- `Session` 是语义状态和生命周期 owner，不带 `Chat` 前缀。
- `Controller` 是 chat-tui adapter，只负责 view projection 与 intent 转发。
- `conversation` 仍表示可持久化的 LLM 记忆，不与进程内 `Session` 混用。
