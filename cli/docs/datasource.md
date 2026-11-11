# 数据源与客户端生命周期

DataSource 表达可复用的访问资源，Client 提供协议操作，Transport 管理访问路径；
它们不拥有业务 Query、诊断结论或报告。Plugin 的声明与 SDK 接入见
[Plugin](plugin.md#协议负责能力对接sdk-负责代码复用)，调用与资源归属见
[Command 生命周期](command-lifecycle.md#context-与调用归属)。

## 共享身份与访问边界

共享基础设施由根 CommandContext 的 ClientManager 持有，命令通过 `clients.get` 借用共享实例，
通过 `clients.create` 创建可提前关闭的独立 Client；两者都不授予根 Manager 的销毁权。
Service 的 `dataSources` 是访问声明的唯一清单，store 只是消费它的诊断视角，
db 与业务 Inspect 不依赖 Store 命令。声明自描述保持离线，运行时 DataSource 不作为 Fact 持久化。
中立生命周期归 TypeScript harness-common；协议 Client 与 Transport 归 toolbox。

DataSource 标识目标与访问配置并构造 Client；Client.initialize 按需解析配置，由 Transport 选择和准备访问路径，
Client.dispose 幂等回收自己拥有的资源。构造函数不执行外部操作，查询及其结果仍属于各次领域调用。
普通领域数据保存在相应模块中，不进入通用 Context 缓存。

Transport 生命周期覆盖借用它的协议 Client。OpenSearch / Redis / S3 复用根持有的 ServicePortForwardTransport，
端口转发选择、准备、失效与清理由 Toolbox 拥有；业务调用结束只关闭自己的 Client。OpenSearch 使用同一 Client
完成协议探测和查询，不再另建 probe 连接或把转发地址写回逻辑 endpoint；Host 与 TLS 身份保留原始目标。
OpenSearch 的访问装配位于 `datasource/opensearch/access.ts`：显式接收 ClientManager、取消信号和
诊断回调，返回协议访问与关闭入口；它不依赖 CommandContext、Collect Step 或归档布局。
`collect/shared/opensearch-access/preparation.ts` 负责适配 Command 作用域，将访问诊断、经过脱敏的
原始异常堆栈和清理失败转换为 Collect Evidence。连接失败是主因，清理失败单独保留；失败清理由
根 Manager 管理时，Finalize 继续报告清理错误。

S3 Provider 的 health/metrics HTTP 请求通过 Toolbox HttpClient 借用同一 Transport，Provider 只持有可请求的 Client，
不把逻辑 endpoint 当成本机可直连 URL。Provider 网络探测失败保留为失败证据，不降级成已确认的 generic-s3。

同一 DataSource 身份的并发调用等待同一次初始化；成功后复用 Client，失败后先清理部分初始化的资源，
再允许后续调用重试。身份包含影响访问的配置和凭据，不能使用对象地址。依赖客户端先获取，消费者后初始化；
finalize 等待所有初始化结束，再按相反顺序销毁，保证数据库先关闭、Kubernetes 通道后停止。
开始销毁后拒绝新获取，即使某个客户端清理失败也继续处理其余客户端。

Plugin 工厂接收独立的 PluginClientContext，其 signal 和受权限约束的 infra 属于根执行树，不能捕获
某次 capability 调用的上下文或 dependency handle。子调用只清理自己的临时资源。直接嵌入 CommandSpec 的
宿主同样负责在整棵调用树结束后调用根 Context 的 disposeClients；CLI 在 finalize 中统一完成此操作。
