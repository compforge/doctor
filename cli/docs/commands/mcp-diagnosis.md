# MCP 诊断设计

## 理念 / 概念

`doctor mcp` 是面向 MCP tool 的通用排查工具。它先确认动态配置和本次目标，再由多个 Probe 分别取得
MCP 调用、映射后直接 HTTP 和网关日志证据，最后由 Detector 基于这些 Evidence 做规则判断。领域层负责
server/tool/args 选择、Probe/Detector 和报告；Plugin MCP capability 负责把内部配置投影成通用 server、
tool 以及可选的 HTTP request plan；
`infra/mcp` 负责官方协议 SDK、transport 与 transcript，`infra/k8s` 负责 Service selector、Pod 日志和
Core 所需的 Kubernetes 访问。

Plugin Catalog 中声明 `mcp` capability 的 Service 决定配置来源、运行端口和业务配置解析规则。
Doctor collect 只消费 capability 返回的中性投影，不感知 Config Storage URL 背后的业务服务，也不继续
采集其 Pod 状态或日志。

MCP tool call 和直接 HTTP 重放都可能产生业务副作用，它们是两次独立操作，不能用一次确认覆盖。

## 流程

1. 解析 profile、Namespace 和输出格式后，从 Plugin Catalog 唯一选择声明 `mcp` capability 的 Service；Doctor 注入 `PluginContext`，capability 自行读取私有配置源并返回 server/tool 中性投影。
2. 网络准备在同一生命周期内解析 MCP Service/Pod、建立 port-forward，并执行 `tools/list` 确认运行时实际暴露的 tools。
3. 根据 Plugin 配置投影与 runtime tools 共同确认 server、tool 和参数；无显式参数时由通用终端交互逐项收集。
   `tools/list` 仍属于动态配置确认，因为后续 Probe 执行前必须先知道共同目标；目标确认后，
   `mcp-configuration` Inspect 不再访问外部资源，只把这份已确认快照发布为冻结 Facts。
4. MCP call Probe 经独立授权后执行 `tools/call`，保留 JSON-RPC response 和完整协议 transcript。
5. Plugin 提供 HTTP request plan 时，HTTP call Probe 生成复现 cURL，经第二次授权后在 gateway Pod 内执行直接 HTTP；未提供映射不影响标准 MCP 诊断。
6. Gateway logs Probe 在两条调用 Probe 后收集本次窗口日志，并按 trace/tool/连接错误筛选为证据；Plugin 配置投影失败记录为 `mcp-config` 证据缺口，Core 不会猜测其私有配置。
7. Detector 只消费结构化 Evidence，比较两条调用路径的成败组合；Render 消费 Diagnosis 输出 Evidence Bundle 或离线 HTML。所有 client 和 forward 在统一收尾路径回收。

## 关键设计

### 协议能力与 Plugin 配置分离

MCP transport、初始化、`tools/list`、`tools/call` 和 transcript 是协议通用能力，属于 `infra/mcp`。
Config Storage 的定位、访问，以及 tenant/server/tool 语义、参数默认值和 HTTP 模板都属于
`plugins/<plugin>` 的 MCP capability。`collect/mcp` 只依赖中性的 server/tool/request-plan 契约，不读取
ConfigMap、不请求 Config Storage，也不把原始业务配置写入 Evidence。
tenant 是 mcp-gateway server 的路由隔离维度，参与唯一身份和 URL path；Plugin 负责解析，Core 只把它
作为已确定的目标身份消费。

### 配置确认允许最小 bootstrap 准备

可选 server/tool 只有读取 Plugin MCP 配置后才能知道，因此 Doctor 在配置确认阶段调用 capability。
Plugin 可通过 `PluginContext.portForward` 准备私有配置访问通道；该上下文与后续 gateway forward 共享命令生命周期，
不迫使 Probe 自己管理临时网络资源。

### tools/list 是配置确认，Inspect 是 Execute 快照边界

Inspect 描述目标原本就存在的环境事实，Probe 描述对已确定目标的一次取证动作。runtime `tools/list`
直接参与 tool 候选确认；若把它放进 Probe，MCP call 与 HTTP call 在启动时反而没有确定目标。配置阶段取得的
configured/runtime tool 快照由无 I/O 的 `mcp-configuration` Inspect 进入 Facts，供后续报告说明目标如何确定。
这个 Inspect 是 Prepare → Execute 的显式只读交接，不把 `tools/list` 伪装成第二次诊断动作；后续 Probe 只能
消费 `runCollect` 冻结后的同一快照。

### Probe 与 Detector 可独立扩展

MCP call、HTTP call 和 gateway logs 分别位于 `probe/`，只负责采证和 Outcome 记账；`detector/` 是纯函数，
不能访问 executor、client 或 Kubernetes。当前 Detector 只判断有证据支持的成败组合，不比较响应正文是否
等价，也不凭日志关键词单独归因。未来增加新的 Probe 或 Detector 不需要改写一条固定排查流水线。

### 两次真实调用分别授权

MCP tool call 与直接 HTTP 是两个独立请求，可能重复写入或修改业务数据。ApprovalGate 分别展示
目标和影响；拒绝只让对应 Outcome unavailable，不阻断只读的配置、tools/list 和日志证据。

### 证据缺失不伪装成协议结论

复杂模板无法可靠还原时明确记录 unsupported；gateway Pod 不可用、session 建立失败或日志窗口无
匹配内容时分别留痕。Render 只展示已取得的响应和缺口，不用猜测补齐协议行为。
