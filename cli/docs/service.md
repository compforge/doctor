# Service 声明与接入

Plugin 作者通过 Service Catalog 描述应用。先声明服务身份与资源，再按命令需要提供可调用的 Extension。安装和运行时加载见 [Plugin 分发](plugin.md)。

## Service 与 Workload 的公共模型

Service、Workload 和 WorkloadInstance 的基础语义来自 `@compforge/harness-common`。
Doctor 的 `ServiceDefinition extends Omit<Service, "environment">` 只增加诊断声明：
Catalog 保留 Component/Repository 归属、Workload 和 capability，不绑定某个现场环境。
调用时 Core 用 `bindService` 注入本次有效目标的 Environment，形成
`context.target.service: Service`；实际连接与 namespace 仍由本次有效参数及受限 infra 管理。
profile 是配置来源，Environment 依据选定的 cluster/context 建立；详见 [配置与目标](configuration.md#environment-与配置来源)。

Workload 直接使用 common 的 `platform / location / namespace / container`；
location 支持 Kubernetes Service、labels 或明确的 Deployment/StatefulSet/DaemonSet/Pod。
Inspect 复用 toolbox 定位实例，不根据逻辑 Service 名猜资源名。
Inspect 的 Fact、Workload Probe 输入和 Evidence 都保留 common WorkloadInstance 的
environment、workload、namespace、pod、uid 和可选 container；缺少 UID 不伪造实例身份。
Inspect 仍按一次一个 namespace 执行；声明指定其它 namespace 时记录 unavailable 并提示
使用 `--namespace` 单独采集，不跨目标复用权限预检或配置快照。

## Service 身份与别名

Service 的 `name` 是稳定身份，`aliases` 是可选的输入同义名称。例如
`{ name: "api-server", aliases: ["api"], ... }` 允许通过任一名称选择同一个 Service。
Catalog 按大小写精确匹配；标准名与别名共享唯一命名空间，重复、冲突、空名称以及含空白或逗号的别名在注册时拒绝。
采集选择在执行前归一为标准名并去重，Evidence 与结果仍使用标准身份。

`doctor plugin` 的文本与 JSON 输出展示 aliases，`--service` 筛选同时接受标准名和别名。
Skill 可以保留自己的 Service 台账与简称，aliases 用于方便对齐，不要求台账与 Catalog 使用相同命名。
别名指向完整的逻辑 Service，不代表它的部分 Workload；Workload、Kubernetes 资源名与 telemetry 名
不会被自动注册为别名，资源选择参数也不会按逻辑 Service 别名重写。

## Service 声明与消费方

Service 的命令扩展通过 Extension 注册；kind 契约由 SDK 定义，Command 选择和组合实现。
调用权限、输入输出、流式生命周期以及 Collect 的 Fact / Observation / Detector 边界见 [Extension](extension.md)。

资源声明与调用协议分别建模：`dataSources` 保存可复用访问资源，`dependencies` 通过
Service 与 dataSource ID 引用其它 Service 的资源。宿主解析依赖并注入受限 handle，管理共享 Client
及其清理。`detectors` 是只消费 Evidence 的纯分析函数；`inspect.probe` 由 Service 提供，Core 统一执行并保存 Value/summary。

`cases` 与 DataSource、Workload 一样是 Service 贡献。一个 `ServiceCaseSource` 用稳定 ID 集中提供
离线 CaseSet、可选的运行时 `produce` 和单请求 `runner`；来源引用是 `{ service, source }`。
Health 的 `healthcheck.*` 扩展引用它并声明消费方 Workload，Perf 从所选来源取得入口 Operation 和单请求 runner，
Case 命令离线展示它。来源决定探测哪些业务对象，命令只补齐所声明的上下文和控制运行策略。

`load()` 不访问 Target；`produce` / `runner` 分别声明 access，并复用宿主的结果信封和资源生命周期。
canonical Case 保存稳定刺激；运行时 subject 保存业务对象身份，targets 保存地址、凭据和新鲜会话。
模型来源可贡献 `MODEL_CONNECTIVITY_CASE_SET`，使用 `modelHttpCases(model)` 绑定其选定模型。
Case 来源可声明同步的 `previewHttp(case)`，通过与 runner 共享的请求构造函数提供离线 cURL 模板。运行时身份和凭据使用占位符。
runner 用 `supports(case)` 声明协议兼容性，同一来源可同时服务 Health、Perf、Eval；Facet 只负责分类。

`trace.analysis` 采用 Trace Harness 的纯分析扩展；`trace.source.dataSource` 是首选存储资源引用。
TraceSession 从已经下载的本地证据准备分析依赖，结束后保存机器证据供离线渲染。
这两项分别属于分析与资源关系，不决定其它 Command 的领域提供方。

模型和租户 Command 按所需 kind 发现候选。唯一候选可直接选用，多候选由显式参数或交互选择决定；
非交互调用遇到歧义会列出候选并报错。公共 Model 只携带可落盘的安全身份和规格，厂商配置与凭据留在实现内。

## Redis source

Plugin API 19 要求 Service 的 Redis DataSource 必须提供 `source`，不再声明环境变量映射。
`redisDataSource(key, resolve)` 的 resolve 由 Plugin 读取并解释自己的配置，返回 toolbox
`RedisDataSourceTarget`：`endpoints` 是所选模式的种子地址，超时统一使用毫秒；Sentinel
使用独立的 sentinel 凭据。Core 不再为 Service 猜测 Redis 环境变量名称或配置来源 Pod。

store 与业务 capability 在各自权限检查后借用同一个根生命周期 Client；连接复用，
拓扑每轮重新发现。MySQL 与 Redis 共用 `tcpTransports` 的原生连接、Pod relay 候选顺序，
只在映射或握手网络失败时切换，认证失败及已发送的命令不会触发重放。访问按 Service/source
保留归属，不以相同 endpoint 合并不同权限与凭据的数据源。源配置及凭据不进入采集证据。

## Service Resource

`Service.resources` 声明持续管理/使用的资源集合及原生 `observe` 操作，复用 Harness Common 的
Resource/ResourceSnapshot。`doctor resource` 按 Service、资源 ID 或开放 `kind` 读取只读快照；
业务关联不注册 Extension。协议、预算与权限语义见 [资源盘点](commands/resource.md)。

### Service Endpoints

`ServiceDefinition.endpoints` 保存声明的对外依赖地址及可选消费方 Workload，Catalog 校验声明。
它不自动触发 Health。需要主动验证的依赖由 Service 显式贡献 `healthcheck.deps`，
Plugin 选择实例、解析运行时配置并复用 Toolbox 网络探测；详细契约见 [Health](commands/health.md)。

## Case 与 Operation

`Service.operations` 声明静态能力及 `calls`、`mayCalls`、`probes`；Case source 通过 `operation`
引用同一 Service 的能力，runner 留在 source 中。Perf 要求这个引用；只提供离线资产的其他来源可以省略。

```text
Operation: chat/chat
  ├─ Case greeting: query="你好"
  └─ Case python:   query="用 Python 计算下 1+1"
```

两种输入使用同一个入口 Operation。第二种输入可能触发工具调用，静态 `mayCalls` 描述这种可能性；
实际发生哪些调用由运行证据说明。Core 在执行前解析引用，运行记录同时保存 Case 与 Operation identity。
Probe 定义不包含环境凭据或实验窗口，由 Host 绑定访问参数、由 Perf 绑定窗口。

## Core 与 Plugin Service 的职责

Core 与 Plugin 使用同一套 Inspect、Probe、Detector 词汇。Service 是业务 contribution、Workload 和运行时
依赖的归属单元；Plugin 是多个 Service 与 Skill 的版本化分发单元。具体 Plugin 只依赖公共 Plugin SDK，
CLI Core 不依赖任何具体 Plugin 实现。

这里统一的是概念、执行阶段和 Evidence 语义，不要求 Core 与 Plugin 直接复用同一个代码 interface。
Core 实现可以直接消费进程内领域上下文；Plugin contribution 还必须携带 Service、版本、access 与分发
边界所需的信息。CLI composition root 负责把选中的 Plugin contribution 适配进同一 Execute 流程，不能
为了统一函数签名丢掉边界信息，也不让 `packages/plugin` 反向依赖 CLI Core。

双方边界分为两层：

| 边界 | 方向 | 所有权 |
|---|---|---|
| Inspect / Probe / Detector contribution | Plugin Service → Core | Plugin 提供业务逻辑；Core 选择、驱动并验证结果 |
| access | Plugin capability → Core | Plugin 声明最小范围；Core 逐操作检查声明，目标系统判权 |
| dependencies | Service → Core | Service 声明所需其它 Service capability；Core 解析并注入受限 handle |
| data | Core ↔ Plugin capability | 公共包定义类型化输入输出；私有 schema 留在 Plugin 内 |
| infra | Core → PluginContext | Core 提供当前 Target 的受限访问、取消和资源生命周期 |
| config | Profile/Core → PluginContext | Core 不透明保存和透传；schema、校验和解释归 Plugin |

这些边界不能互相替代：取得 infra handle 不代表获得任意权限；config 不承载 kubeconfig 等 Core-owned
连接状态；业务返回值不能泄露整包私有配置；Plugin contribution 不能推进或绕过 Core 生命周期。

Kubernetes 只是 Doctor Host 到 Target 的一种访问通道。Core 解析 kubeconfig/context，托管查询、超时、
输出上限、取消和 port-forward 回收；Plugin 通过 Workload discovery 描述业务部署拓扑，通过 capability
持有专有 API 与业务语义。Plugin 不持有 kubeconfig，也不自行启动 kubectl。

### 执行阶段分工

| 阶段 | Core | Plugin Service |
|---|---|---|
| Prepare | 解析并校验用户意图；选择 Target、Service 与 contribution；绑定已选 capability 的 access 声明；创建本轮上下文和清理责任 | 声明 Service、Workload、capability、dependency、access 与 contribution；校验 Plugin-owned config；不自行创建命令生命周期 |
| Inspect | 形成 Query；决定 Inspect 的依赖、顺序、预算、遍历、去重和失败隔离；驱动 Core/Plugin Inspect；规范化并冻结 Facts | 执行一批业务 Inspect Query，逐项返回结果与 Fact/Relation；拥有私有协议和业务数据语义，不拥有遍历或后续调度 |
| Probe | 根据冻结 Facts 生成计划；向 Probe 注入公共 Fact；控制依赖、策略、授权、风险和资源生命周期；驱动 Core/Plugin Probe | 执行一次业务 Probe，消费 Input/Facts 并返回 Observation；不内建循环、并发或跨 Probe 调度 |
| Detector | 构建 Evidence；统一执行 Core/Plugin Detector；校验证据引用与 provenance；形成 Findings 和 Diagnosis | 提供纯业务 Detector，消费只读 Evidence，返回带显式证据引用的 Finding；不接收运行上下文或发起 I/O |
| Finalize | 释放 Client，序列化结果，按需驱动 Renderer，完成 Delivery、Cleanup 与最终退出语义 | 不拥有阶段或资源生命周期；业务语义已通过 Fact、Observation 与 Finding 进入 Diagnosis |

Plugin 不必在每个阶段都有可执行逻辑。Prepare 中它主要提供声明，Execute 中贡献业务采集和判断，
Finalize 则由 Core 收口。Renderer 的领域逻辑归 Command 所属模块，通过 `CommandSpec.render` 在根 Finalize 中驱动；只消费本地结果与证据。

## 协议负责能力对接，SDK 负责代码复用

`doctor-plugin` 同时承担稳定协议和可选 SDK，但两者职责不同。协议定义 Plugin/Service/capability 的
声明、调用输入输出，以及所有 Service 共用的 `PluginContext`；上下文提供 namespace、当前 Service、
取消信号和 Target-scoped Kubernetes access。Service 是业务诊断对象，并显式声明零到多个 Workload；
Workload discovery 把 Kubernetes Service 或 Pod selector 投影为运行 Instance，不从业务 Service 名推断
Kubernetes 资源名。profile 切换后，Doctor 在下一次调用中注入新的上下文，Plugin 不持有 kubeconfig
或旧环境选择。

Service capability 的输入只由两部分组成：Core 已知且受控的 `PluginContext`，以及该
capability 实际需要的业务输入。`PluginContext` 可以携带有效 Environment、当前 Target namespace、
已选逻辑 Service、Plugin-owned config 和受 access 约束的 infra。Core 只在执行 Workload-scoped capability
时按声明解析 Instance 并传入；其它 capability 不会收到与其无关的 Pod 或部署细节。

当逻辑 Service 的配置来源不在当前 Target namespace 时，Plugin 可以通过 Kubernetes access 的
`inNamespace` 在同一 Target cluster 内自行发现。每条 access rule 的 `namespace` 省略时绑定当前目标，
指定时只允许该 namespace；多个候选分别声明，只有确需全集访问才使用 `allNamespaces`。
当前 namespace 是 Core 已知的调用上下文，不是逻辑 Service 必须同名部署于此的假设。
例如 VDB DataSource 可由 `datasource.vdb.inspect` Extension 自行定位配置来源，再向 Core 返回统一的
`ServiceVdbTarget`；Core 只消费这个结果完成标准 VDB 诊断。

Service 使用 `dataSources[]` 声明数据源的 id、类型、用途与访问方式。
它是访问能力，不是业务 Fact；声明中的工厂、凭据与运行时对象不会进入自描述或 Evidence。
DB 必须通过 `source: PluginDataSource<MysqlClient>` 贡献访问能力；
可用 SDK 的 `mysqlDataSource(key, resolve)` 构造 source，配置解析在 Client 初始化时执行，
回调收到根执行生命周期内的上下文，不能捕获短生命周期的 capability context。
同一 Service 可声明多个同类型 dataSources，每个 ID 保留稳定的逻辑依赖身份；不同声明在某个环境
可能解析到同一目标，也可能分开部署。目标归并由消费命令依据解析结果完成，不能用声明 ID 或
Client 的缓存 key 代替资源身份。库表通过 Client 实时发现，不由 Plugin 重复维护清单。
`store`、`db` 与业务 Inspect 消费同一 source，共享访问而不共享查询结果。
数据库环境变量、配置文件和来源副本选择由 Plugin 实现；Core 只借用初始化后的 Client。

DB、VDB、S3、Redis 都可通过 `source` 贡献实现 initialize/dispose 的类型化 Client，由同一根
ClientManager 初始化、复用和释放。SDK 的 `mysqlDataSource`、`vdbDataSource`、`s3DataSource` 和
`redisDataSource` 把配置解析接到 toolbox Client；Plugin 可从配置 API、文件或声明的 Kubernetes
访问取得连接信息，无需把配置伪装成 Pod 环境变量。协议操作仍由各类 Client 表达，不提供万能 execute。
S3、VDB、Redis source 的 Kubernetes Service endpoint 按其 DNS 中的 namespace 建立转发，
保持原始 Host/SNI。跨 namespace 连接需在 capability 的 `pods/portforward` 权限声明中启用
`allNamespaces`；配置来源的 namespace 不改变对象存储等后端的部署位置。

S3 环境变量映射和 VDB 配置投影是内置配置来源，与自定义 source 互斥。内置来源通过 Service.workloads
定位实际 Pod/container，不要求业务 Service 与 Kubernetes Service 同名；定位失败或来源有歧义时
明确报错。使用 source 时不要求存在配置来源 Pod，也不额外探测 source 未提供的 Provider HTTP 接口。

Workload 日志读取在流开始、结束时核对 Pod UID 和已知的 runtime container ID。实例变化或验证失败
时保留原始证据并标记 unavailable，不将内容投影成原实例的正常日志；缺少 runtime ID 时标记 partial。
边界校验用于发现替换，不承诺 Kubernetes 日志流具备原子快照语义。
跨 Service 依赖通过 `{ service, capability: "dataSources", dataSource }` 引用声明；
引用本身不授予额外权限，也不保证不同权限作用域会合并连接。当前跨 Service 运行时依赖 handle
实现的是受限 OpenSearch search；数据库消费者可共享声明中的 source 工厂。
详见 [数据库取证](commands/db.md)。

网络 endpoint 跟随实际消费它的 capability 声明，不放在 Service 根上假设一个全局端口。同一 Service
可以分别为 tenant directory、model catalog、inference 或 MCP 提供不同 endpoint；命令只为
本轮选中的 capability 建立对应连接。endpoint 必须显式声明 `host` 与 `port`，Core 不用逻辑 Service 名
推导网络地址。

Kubernetes 传输以及 port-forward 的本地端口分配、取消和回收由宿主按调用或共享资源的生命周期管理，因此由
`PluginContext` 按需提供。中立 Client、DataSource 与 ClientManager 契约由 TypeScript
`@compforge/harness-common` 提供；`@compforge/harness-toolbox` 提供 Transport 与具体协议 Client。
common 与 toolbox 都不依赖 Plugin 协议或命令上下文；Plugin 通过宿主提供的受权限约束接口使用
Kubernetes Transport，不能绕过 capability access 检查。协议不注入 Core 私有客户端实现。Workload discovery 规则、
API、SQL、表结构及诊断知识始终属于具体 Plugin；Kubernetes 查询、port-forward 和资源回收由 Core 执行。

Service 通过 `context.clients.get(dataSource)` 获取已初始化的 Client。DataSource 的 `clientKey` 表达 Plugin 内的
目标及访问策略；Host 自动按 Kubernetes 环境、namespace、Service、endpoint、配置、数据库身份与声明的
access 隔离。同一 `clientKey` 必须对应同一种 Client。配置身份只保留内存摘要，不输出凭据；每次 capability
操作仍检查自己的 access 声明，客户端复用不扩大权限。

DataSource.createClient 接收 PluginClientContext，返回实现 initialize/dispose 的 Client。工厂只构造对象，
外部操作归 initialize；dispose 必须幂等，并能清理初始化失败留下的资源。工厂上下文的 signal 和 infra
属于整棵执行树，没有单次调用的依赖 handle，也无需手动注册共享客户端 cleanup。

`mysqlDataSource` 与 `redisDataSource` 复用 `tcpTransports(context)`，原生建连网络失败后尝试 Pod relay。

Plugin API 17 的资源查询显式声明 API version 与 REST 资源复数名，例如
`infra.kubernetes.get({ apiVersion: "v1", resource: "services", name: "api" })` 与
`infra.kubernetes.list({ apiVersion: "v1", resource: "pods", labelSelector: "app=api" })`。
列表保留 `items` 与分页 metadata，后续页由调用方显式读取。`inNamespace()` 借用相同根客户端，
每次操作仍按 API group、resource、name 与 namespace 检查 capability access；不同 API group
不能借用同名资源的声明。Core 使用 harness-toolbox 的原生 HTTP 连接池，直接保留结构化错误；
文件源定位与其他 Plugin 查询共享池，根 Command 统一关闭。exec 与 relay 继续使用各自执行通道。

`infra.kubernetes.podRelay` 借用现有 Pod 中转 TCP。该访问需声明 `list pods`、`create pods/exec` 和
`create pods/portforward`；不创建 Pod，也不要求业务方指定 helper Service 或解释器。
同一根执行中相同 cluster/namespace 共用 relay，Service 和数据库身份不参与传输身份；每个调用方
仍独立检查 access。通道容量与超时由 Host 统一限定，根执行结束统一关闭。

Client 持有初始化所需的运行时配置，并自行限制并发。MySQL 使用单个查询槽位，
通过借用的 TCP 通道复用原生连接，保留连接与查询超时。ClientManager 合并并发初始化，失败清理后允许重试；
根 finalize 集中关闭消费者和其依赖的 Kubernetes Client。借用的 Kubernetes 通道不能由某个数据库客户端关闭。
客户端复用只覆盖访问准备和连接；领域层是否复用查询由其显式的本轮执行契约决定。
共享 Client/Transport 的完整生命周期与 Core 访问装配见 [数据源生命周期](datasource.md)。


access 跟随实际被调用的 capability，而不是汇总成 Plugin 的最大权限。Doctor 先根据命令和用户选择确定
本轮参与的 Service。Core 在每次实际操作前校验该 capability 的声明边界，再由目标系统授权实际请求。
打开 capability 不执行整批 RBAC 预检，不要求未选择的 fallback 或 transport 权限；显式权限诊断仍可使用
绑定实际 namespace 的 `can-i`，其结果不能代表业务查询成功。用户审批与 Host 策略独立于目标系统判权。

Plugin 的贡献深度随 command 类型变化：业务型命令由 capability 执行业务访问并返回约定数据；
基础设施型命令只需要 Plugin 贡献目标或连接信息，标准诊断算法仍由 Core 持有；混合型命令先由 Plugin
完成业务 ID、私有配置等投影，再交给 Core 的标准采集阶段。各阶段和访问边界见
[Core 与 Plugin Service 的职责](#core-与-plugin-service-的职责)。

### 文件数据源

`fileDataSource(paths, { workload, access, resolve })` 直接作为数组成员，
无需 Store 的 `id/kind/source` 包装。加载 Catalog 不执行 `resolve`；宿主首次创建客户端时
传入 `PluginClientContext`，定位 Pod/Container，随后按需读取。底层复用 Quality Harness
的 `PodFileDataSource`，客户端由根 Command 管理，文件读取有大小与时间上限。
`paths` 是非空、无重复的绝对路径数组，表示可以从同一 Pod/Container 一起获取的文件组；
组内只定位一次目标、发起一次 exec，逐文件返回结果。单文件失败不丢弃成功文件。
Plugin API 18 使用路径数组和 `infra.kubernetes.readFiles`，Plugin 需按新接口重新构建。
`configurationInspection` 已移除。

### Service Overview 与 Health

Overview 通过 `facet.summarize` 展示维度统计，通过 `duration.summarize` 展示耗时分布。
Entry data 可以是数值或文字；全部条目都保留，只有同一 namespace 声明 `facet.sample` 且 Entry
支持 `canSample` 时才开放采样。Core 负责冻结窗口、展示、用户确认、样本去重及 Collect 编排；
Plugin 负责统计口径与代表请求选择。

Health 只执行显式的 `healthcheck.infra/self/deps/biz`，按 scope 跨 Service 递进。
Plugin 拥有检查与判定；Core 负责调度、批准和证据交付。共享 Case 来源的 `produce` 负责准备用例。
Health 只发现 Service namespace，未指定服务时默认选择支持巡检的服务；历史统计由 Overview 展示。
详见 [Overview](commands/overview.md) 与 [Health](commands/health.md)。

Plugin Kubernetes `exec` 支持 stdin 和不超过宿主上限的 timeoutMs；凭据与协议参数应走 stdin，
不得放入命令参数。取消信号、权限检查及资源生命周期继续由宿主管理。

### Extension 与 Data 接入

Service.extensions 提供开放 kind 的 Extension；Extension、kind 标识及各 kind 的输入输出契约统一定义在
`packages/plugin`。Catalog 按 kind 离线发现，不调用实现；Extension.access 声明实际访问需求。
Data 使用 data.id，prepare 选择实现，run 再通过宿主的受限上下文按操作检查声明并取数。输入是 Query
列表，输出逐 Identity 关联，复用既有 Fact 与预算校验；它无需数据库式 resolveTarget。

Service 的其它 kind 不扩大 Data 的权限范围；当前 Data 每个 Service 只接受一个 data.id 实现。
通用扩展协议见 [Extension](extension.md)，Data 领域规则见 [Data](commands/data.md)。
