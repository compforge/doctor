# @compforge/doctor-plugin

Doctor Plugin 的协议与可选共享 SDK。Plugin 是 Service 与 Skill 的打包和分发单位：一个业务 Plugin
通过本包导出一个 `PluginDefinition`，其中 Service Catalog 可以包含多个 Service，每个 Service 独立声明
capability 及其 access，同一精确 Plugin 版本还可携带多个已解析的 Skills。Doctor 只注入
`PluginContext`。其中 Kubernetes access 和 port-forward 由 Core 绑定到已选 Target，具体 HTTP、数据库
协议和业务查询由 Plugin 持有。例如 `traceId` capability 只约定业务 ID 到规范 `trace_id` 的输入输出，
查询哪个 Service、如何解释数据源和 ID 的业务语义都留在 Plugin。

Service 可以通过 `Toolchain` 声明稳定的源码语言、执行平台、依赖管理器和构建工具。该声明帮助 Core
选择通用依赖、性能与产物采集器；当前镜像、runtime version 和实际依赖仍由 Core 从 Target 观察，
Toolchain 不作为现场状态使用，也不携带自定义执行命令。

`PluginDefinition.id` 与 `PluginDefinition.version` 共同构成运行时身份。同一 `plugin@version` 的代码和
Skills 内容不可变；`scripts/version.ts` 对两类内容统一计算并校验版本锁，任一内容变化都需要 bump
Plugin version 后重新封存。

协议返回值既可以是可持久化数据，也可以是临时 capability handle。后者只暴露 Core 需要的规范化身份
和操作方法，适合让原始凭据、厂商字段与请求拼装始终留在 Plugin 内。

Core 与 Plugin 以 capability 为中心：capability 是 Doctor 发现、准备和消费 Plugin 能力的入口；access
声明、调用时交换的类型化 data、Core 注入的 Target-scoped infra，以及 profile 中不透明透传的 Plugin
config 都只支撑 capability 的调用，不形成平行的扩展生命周期。config 的 schema 与解释权归 Plugin；
kubeconfig、context 等 Core-owned 连接信息不会伪装成 Plugin config。

只读数据能力接受由类型化 `Identity` 与 capability-specific constraints 组成的 `Query`，并返回一个或
多个独立领域 Fact；每个 Fact 也可携带已证实的 `Relation`。Capability 不绑定具体 Doctor Command；Command 选择能力、限制 Relation
扩展并把结果组织为 Evidence。summary/table 等展示投影不能反向驱动 Query。

`trace` 是一个 Plugin-level capability：`source` 声明 Core 采集 trace 所需的业务 Store，`analysis` 直接
使用 trace-harness 定义的 `TraceContributions`。分析扩展只能消费已标准化的 Trace IR/Facts；采集、配置、
凭据和外部访问仍在进入 Trace Harness 前完成。

`case` 是 Service 的稳定 CaseSet 与单次请求 runner；runner 实现 HTTP/SSE、鉴权和协议分类，但不拥有
加压循环。`perf` 只在 CaseSet 上声明本次 Case mix 与可观测性预设，调度、预算、熔断和统计由 Core 的
Perf Harness 统一完成。

`PluginSkill` 是 runtime 视图，不规定归档或磁盘布局。Plugin loader 或定制发行入口负责读取
`SKILL.md`，并把内容及可由宿主 `ExecutionEnv` 访问的绝对路径注入对应 `PluginDefinition`。Skill 因此
跟随 Plugin 安装、选择、信任与升级，同时不让 Plugin SDK 依赖具体 agent framework。
