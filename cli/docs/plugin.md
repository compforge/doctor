# Plugin 分发

## 理念 / 概念

### Service 与 Workload 的公共模型

Service、Workload 和 WorkloadInstance 的基础语义来自 `@compforge/harness-common`。
Doctor 的 `ServiceDefinition extends Omit<Service, "environment">` 只增加诊断声明：
Catalog 保留 Component/Repository 归属、Workload 和 capability，不绑定某个现场环境。
调用时 Core 用 `bindService` 注入当前 profile 对应的 Environment，形成
`context.target.service: Service`；实际连接与 namespace 仍由本次有效参数及受限 infra 管理。
环境名是逻辑 profile 身份，不是集群唯一标识，连接缓存仍按实际 Kubernetes 配置隔离。

Workload 直接使用 common 的 `platform / location / namespace / container`；
location 支持 Kubernetes Service、labels 或明确的 Deployment/StatefulSet/DaemonSet/Pod。
Inspect 复用 toolbox 定位实例，不根据逻辑 Service 名猜资源名。
Inspect 的 Fact、Workload Probe 输入和 Evidence 都保留 common WorkloadInstance 的
environment、workload、namespace、pod、uid 和可选 container；缺少 UID 不伪造实例身份。
Inspect 仍按一次一个 namespace 执行；声明指定其它 namespace 时记录 unavailable 并提示
使用 `--namespace` 单独采集，不跨目标复用权限预检或配置快照。

### Service 身份与别名

Service 的 `name` 是稳定身份，`aliases` 是可选的输入同义名称。例如
`{ name: "api-server", aliases: ["api"], ... }` 允许通过任一名称选择同一个 Service。
Catalog 按大小写精确匹配；标准名与别名共享唯一命名空间，重复、冲突、空名称以及含空白或逗号的别名在注册时拒绝。
采集选择在执行前归一为标准名并去重，Evidence 与结果仍使用标准身份。

`doctor plugin` 的文本与 JSON 输出展示 aliases，`--service` 筛选同时接受标准名和别名。
Skill 可以保留自己的 Service 台账与简称，aliases 用于方便对齐，不要求台账与 Catalog 使用相同命名。
别名指向完整的逻辑 Service，不代表它的部分 Workload；Workload、Kubernetes 资源名与 telemetry 名
不会被自动注册为别名，资源选择参数也不会按逻辑 Service 别名重写。

### Plugin 边界

Doctor Core 保持开源，但具体 Plugin 的 Service Catalog、固定查询和排障知识可能属于企业内部资产。
Plugin 通过版本化、自包含、可离线交付的归档分发这些业务扩展，同一份交付物同时贡献：

- **PluginDefinition**：向确定性诊断提供 Service Catalog 和Trace 分析与资源引用，并在运行时携带同版本
  已解析的 `PluginSkill`；
- **Skill 资源**：采用标准 `SKILL.md` 目录，供本地 `doctor chat` 的 agent loop 渐进加载业务知识和脚本。

Plugin 是 Service 与 Skill 的打包和分发单位。`PluginDefinition` 是唯一运行时入口，`id@version`
构成其精确身份，其中
Service Catalog 可包含组成同一应用的多个 Service，每个 Service 各自声明 capability、所需 access
以及对其它 Service capability 的运行时依赖；
同一 Plugin 也可携带多个 Skill。Plugin manifest 只定位代码和 Skill，loader 再把已解析的 Skill runtime view 附到
`PluginDefinition.skills`，不重复声明 store、log、data、model 等能力。
例如业务 ID 到规范 `trace_id` 的转换由 Service 的 `trace.resolve` Extension 声明：一个业务 ID 可返回一条
或多条 trace resolution，并可携带直接承载 trace 的来源 ID。`trace`/`log` 只消费其约定结果，不通过
通用 data 查询或 span tag 猜测业务关系；命令批量输入的调度和按 ID 分组交付仍由 Core 负责。

monorepo 中的源码按依赖方向分为三层：

```text
cli/src/plugin/              Plugin 安装、选择与加载的宿主边界
packages/plugin/             doctor-plugin 协议与可选共享 SDK
plugins/<plugin>/            可独立构建、归档和分发的具体 Plugin 实现
```

领域依赖保持 `cli/collect -> packages/plugin <- plugins/<plugin>`。CLI core 只接收注入的
`PluginDefinition`，不引用具体 Plugin；根目录发行构建和 Host loader 分别负责在编译期、运行期
取得具体实现，collect 不感知来源。

Service 的对外操作统一通过 Extension 注册；kind 契约由 SDK 定义，Command 选择和组合实现。
调用权限、输入输出、流式生命周期以及 Collect 的 Fact / Observation / Detector 边界见 [Extension](extension.md)。

资源声明与调用协议分别建模：`dataSources` 保存可复用访问资源，`dependencies` 通过
Service 与 dataSource ID 引用其它 Service 的资源。宿主解析依赖并注入受限 handle，管理共享 Client
及其清理。`detectors` 是只消费 Evidence 的纯分析函数；`environmentProbes` 是 Core 执行的环境检查声明。

`trace.analysis` 采用 Trace Harness 的纯分析扩展；`trace.source.dataSource` 是首选存储资源引用。
TraceSession 从已经下载的本地证据准备分析依赖，结束后保存机器证据供离线渲染。
这两项分别属于分析与资源关系，不决定其它 Command 的领域提供方。

模型和租户 Command 按所需 kind 发现候选。唯一候选可直接选用，多候选由显式参数或交互选择决定；
非交互调用遇到歧义会列出候选并报错。公共 Model 只携带可落盘的安全身份和规格，厂商配置与凭据留在实现内。

持久化模型只包含两个事实：

1. Doctor Host 已安装哪些 `plugin@version`；
2. Doctor Host 当前加载哪个精确插件版本。

Plugin 安装/加载是 Host 级生命周期，profile 只选择诊断环境并提供该环境下的 Plugin config。两者正交，
不增加 Package / Instance / Binding 或常驻插件进程。

```text
Plugin archive ──install──> ~/.doctor/plugins/<plugin>/<version>/
                                      │
                         active.json ─┘
                              ├── PluginDefinition ──> ServiceCatalog ──> collect
                              └── Skills ─────────────────────────────> local doctor chat

Profile ──> target / access / Plugin-owned config
```

一个 Plugin 可同时携带多个 Service 和多个 Skill。切换 profile 只改变它们面对的环境、权限和配置，
不会加载或卸载 Plugin。当前加载一个业务 Plugin，不为多个业务 Plugin 的并行组合设计额外生命周期。

## 流程

### 归档与安装目录

Plugin archive 使用 tar/tar.gz；所有归档来源统一落到同一安装目录：

```text
~/.doctor/plugins/
├── active.json
└── sample/
    └── 1.2.0/
        ├── plugin.json
        ├── plugin.mjs
        ├── .doctor-install.json
        └── skills/
            ├── service-ops/
            │   └── SKILL.md
            └── trace-ops/
                └── SKILL.md
```

归档文件名不参与身份判断，真实 `id` 和 `version` 只取自根目录的 `plugin.json`。manifest 的最小形态：

```json
{
  "manifestVersion": 1,
  "pluginApiVersion": 11,
  "id": "sample",
  "version": "1.2.0",
  "requiresDoctor": ">=0.1.0",
  "contentDigest": "sha256:<64-hex>",
  "main": "./plugin.mjs",
  "skills": ["./skills/service-ops", "./skills/trace-ops"]
}
```

Plugin 入口是可直接执行的 Node-compatible ESM，默认导出一个 `PluginDefinition`。manifest id 与导出
对象 id 必须一致；`pluginApiVersion` 必须与当前 Doctor 支持的 Plugin API 精确匹配。归档必须自包含运行依赖，不在客户现场执行 `npm install`、
install script 或编译 TypeScript；Skill 目录可携带其 `references/`、`scripts/` 等标准资源。

Service Catalog 还可声明 Toolchain，表达源码语言与稳定构建方式，供 Core 选择通用诊断采集器。它是
Plugin 知识而非 Target Fact：当前 runtime、镜像和实际依赖必须在 collect 阶段重新观察；Plugin 不通过
Toolchain 下发任意命令。

### 构建归档

```bash
cd plugins/example
make build
# dist/example-<version>.doctor-plugin.tar.gz
```

Plugin 在自身 `dist/` 中产出 `<id>-<version>.doctor-plugin.tar.gz`。归档只包含 manifest、已 bundle 的
ESM 入口和 Skills，不包含 TypeScript 源码或 `node_modules`。`plugins/example/Makefile` 是可复制的
最短构建入口。

### `doctor plugin install` / `uninstall`

```bash
doctor plugin install ./sample-1.2.0.doctor-plugin.tar.gz
doctor plugin uninstall sample@1.2.0
```

`install` 是面向用户的一步式“安装并加载”操作：

1. 在临时目录解包，读取并校验 manifest、Doctor 版本兼容性和所有资源路径；
2. 按 `contentDigest` 校验实际 ESM/Skill payload，加载代码入口并校验 `PluginDefinition` 的身份、
   Service/capability 结构和跨 Service 引用，扫描 Skill 的基础元数据并附加 runtime view；
3. 原子移动到 `~/.doctor/plugins/<id>/<version>/`；目标版本已存在时不原地覆盖；
4. 在安装完全成功后把精确 `id@version` 原子写入 `~/.doctor/plugins/active.json`；
5. 已加载同一 Plugin 的旧版本时替换 Host 级引用，但保留旧版本目录。

安装时生成 Host-owned `.doctor-install.json`，封存归档、manifest 与实际 payload 的摘要；后续每次加载
都在 import Plugin 代码前重新校验。安装目录中的版本内容不可变。失败发生在 active state 更新前，不改变当前可用版本；旧版本由
`uninstall` 显式清理，不隐含在 install 中。卸载当前版本时同时清除 Host 级 active state。

profile 可提供随环境变化的 Plugin config，但不保存 Plugin 身份：

```yaml
profiles:
  sample:
    plugin:
      config:
        region: example
```

`config` 由 Core 原样保存并只放进已加载 Plugin 的调用上下文。Core 不根据其中字段推导 Target 或权限；
Plugin 通过 `validateConfig` 在命令准备阶段校验自己的 schema，校验完成前不会开始 Target 访问。

### 命令运行

`doctor plugin` 是离线发现入口，展示采集命令实际使用的 Plugin 与 Service Catalog，支持 text/json。
它复用“入口注入优先，否则加载 Host active 版本”的规则，不扫描未激活版本，也不准备 profile、
调用业务 capability 或访问目标环境。来源 `injected` 表示由 composition root 提供（通常是内嵌，
也可能是调用方动态加载），`installed` 表示本机激活的安装版本。Service 的 Extension/Detector
名称直接投影自声明；这些名称不是 CLI 命令清单，Catalog 存在也不代表现场可达。

`doctor plugin --service <name>` 按逻辑 Service 身份筛选并展示详情；未知 Service 报错，不返回伪装成功的
空目录。JSON 保留名称数组，增加 `description` 与 `details`；概览和详情使用 SDK `describeService`
对同一份执行声明的显式投影，不维护平行的能力清单。没有说明的 Plugin 仍可发现，展示“未提供”而不补造含义。

Service 的 `description` 解释职责，Workload 的 `description` 解释运行负载的用途；Inspect 的
`description` 和 `limitations` 解释查询用途和证据盲区。
每个 Query 使用一个 Identity，`accepts` 是它可接受的种类，不是多个必填参数；`provides` 和 `expands`
分别声明可能得到的 Fact 与关联 ID，不保证每次都返回，更不能反推输出 ID 也可直接查询。
限制说明不执行预算或授权；实际边界继续由查询预算、access 和既有执行契约约束。

离线投影只提取静态 Workload、Store 身份、依赖和访问需求等允许公开的字段，不序列化 endpoint、配置或函数，
也不调用 resolver、factory 或诊断 handler。访问需求只是 Plugin 声明，不是 Core 合成的完整访问计划。
说明文字由 Plugin 作者负责保持无敏感信息；加载 Plugin 仍执行受信任模块的导入，并非不可信代码沙箱。
CLI 的命令与发行名称归 composition root，Service 不保存可执行命令字符串。

CLI composition root 从 Doctor Host 的 active state 加载精确 Plugin 版本：

1. 校验 active ref 的版本仍存在，并加载 Plugin 代码与 Skill；
2. Skill name 冲突时直接报错，不按加载顺序静默覆盖；
3. 需要业务语义的 collect 命令取得 Host 已加载的 `PluginDefinition`，进入通用 collect 链路；
4. Plugin command 始终可见，缺少 required capability 时提示具体缺口；不依赖 Plugin 的 Core/离线命令
   保持零配置可用；
5. `doctor chat` 使用 Host 已加载 Plugin 所携带的 Skills，并把解析结果交给本地 Agent。

启动本地 Agent 前，Doctor 以 profile name 作为 env 标识，并把 env、namespace、readonly 组成
`SkillExecutionTarget`。Plugin 可用 `prepareSkillContext` 补充 OpenSearch、DB 等业务访问事实；Core
直接把 kubeconfig 等 profile-owned target 字段写入脚本的 `TARGET_*` 环境，不经 Plugin 转交。profile
确定的 target 字段始终覆盖 Plugin 返回值，避免 Plugin 在无感知情况下把会话重定向到另一环境。凭据
只能进入执行环境，不能写进会被模型看到的 `contextPrompt`。

Plugin 是 Doctor Host 的本地状态。CLI 不向远端执行环境隐式上传本地 Skill 或 Plugin；会话级上传属于
独立协议和授权能力，不隐含在 Plugin install 中。

### 升级与回退

升级不需要独立状态机：install 新版本成功后，将 Host 的精确版本引用从旧版切到新版。旧版本仍在时，
重新 install 对应归档即可回退。进程启动后不监听目录变化；正在运行的命令或 chat 继续使用启动时解析的
版本，新版本在下一次进程启动时生效。

## 关键设计

### Plugin 生命周期与 profile 正交

Doctor Host 负责 Plugin 的安装、加载和版本身份；profile 负责目标环境、凭据和该环境下的 Plugin config。
切换 profile 不改变代码与 Skills，安装或卸载 Plugin 也不改写任何 profile。

### 确定性能力与 Skill 共用版本生命周期

`PluginDefinition` 的 capability 是确定性诊断代码，`PluginSkill` 是 agent 使用的知识与工作流。
两者运行接口独立，但由同一个 runtime definition 汇合，并共同跟随 Plugin 安装、选择、信任和升级；
Skill 没有平行的全局生命周期。

同一 `plugin@version` 的代码与 Skill 内容不可变。Plugin workspace 对 `src/` 和 `skills/` 统一计算内容锁；
构建和测试只接受与当前 version 匹配的锁，任一目录变化都必须 bump Plugin version 后重新封存。

Skill 资源本身保持宿主中立：同一份多环境台账和脚本原样分发。环境选择与基础设施连接属于宿主和
Plugin 的准备边界，不通过裁剪 Skill、修改 Skill 文案或维护宿主专属副本表达。

### 协议负责能力对接，SDK 负责代码复用

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
`inNamespace` 在同一 Target cluster 内自行发现，并为跨 namespace 操作声明 `allNamespaces`
access。当前 namespace 是 Core 已知的调用上下文，不是逻辑 Service 必须同名部署于此的假设。
例如 VDB DataSource 可由 `datasource.vdb.inspect` Extension 自行定位配置来源，再向 Core 返回统一的
`ServiceVdbTarget`；Core 只消费这个结果完成标准 VDB 诊断。

Service 使用 `dataSources[]` 声明数据源的 id、类型、用途与访问方式。
它是访问能力，不是业务 Fact；声明中的工厂、凭据与运行时对象不会进入自描述或 Evidence。
DB source 使用 `PluginDataSource<MysqlClient>`，与标准 `envPrefix` 简写互斥；
可用 SDK 的 `mysqlDataSource(key, resolve)` 构造 source，配置解析在 Client 初始化时执行，
回调收到根执行生命周期内的上下文，不能捕获短生命周期的 capability context。
多个数据库目标声明多个 dataSources；库表通过 Client 实时发现，不由 Plugin 重复维护清单。
`store`、`db` 与业务 Inspect 消费同一 source，共享访问而不共享查询结果。

DB、VDB、S3、Redis 都可通过 `source` 贡献实现 initialize/dispose 的类型化 Client，由同一根
ClientManager 初始化、复用和释放。SDK 的 `mysqlDataSource`、`vdbDataSource`、`s3DataSource` 和
`redisDataSource` 把配置解析接到 toolbox Client；Plugin 可从配置 API、文件或声明的 Kubernetes
访问取得连接信息，无需把配置伪装成 Pod 环境变量。协议操作仍由各类 Client 表达，不提供万能 execute。

环境变量映射和 VDB 配置投影是内置配置来源，与自定义 source 互斥。内置来源通过 Service.workloads
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
可以分别为 tenant directory、model catalog、inference、MCP 或 metrics 提供不同 endpoint；命令只为
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
调用仍先通过自己的 access 预检，客户端复用不扩大权限。

DataSource.createClient 接收 PluginClientContext，返回实现 initialize/dispose 的 Client。工厂只构造对象，
外部操作归 initialize；dispose 必须幂等，并能清理初始化失败留下的资源。工厂上下文的 signal 和 infra
属于整棵执行树，没有单次调用的依赖 handle，也无需手动注册共享客户端 cleanup。

`mysqlDataSource` 与 `mysqlTransports(context)` 在原生建连发生网络错误后，通过
`infra.kubernetes.podRelay` 借用现有 Pod 中转 TCP。该访问需声明 `list pods`、`create pods/exec` 和
`create pods/portforward`；不创建 Pod，也不要求业务方指定 helper Service 或解释器。
同一根执行中相同 cluster/namespace 共用 relay，Service 和数据库身份不参与传输身份；每个调用方
仍独立检查 access。通道容量与超时由 Host 统一限定，根执行结束统一关闭。

Client 持有初始化所需的运行时配置，并自行限制并发。MySQL 使用单个查询槽位，
通过借用的 TCP 通道复用原生连接，保留连接与查询超时。ClientManager 合并并发初始化，失败清理后允许重试；
根 finalize 集中关闭消费者和其依赖的 Kubernetes Client。借用的 Kubernetes 通道不能由某个数据库客户端关闭。
客户端复用只覆盖访问准备和连接，各次 SQL、Overview Entry 查询与诊断结果独立执行。


access 跟随实际被调用的 capability，而不是汇总成 Plugin 的最大权限。Doctor 先根据命令和用户选择确定
本轮参与的 Service，再把 Core command 自身需求与这些 capability 的声明合成阶段性的 access plan；
因此同一 Plugin 中未参与本次命令的 Service 不会扩大预检权限。

Plugin 的贡献深度随 command 类型变化：业务型命令由 capability 执行业务访问并返回约定数据；
基础设施型命令只需要 Plugin 贡献目标或连接信息，标准诊断算法仍由 Core 持有；混合型命令先由 Plugin
完成业务 ID、私有配置等投影，再交给 Core 的标准采集阶段。分类、典型命令和 Kubernetes 分工统一见
[`kernel.md`](kernel.md#业务型基础设施型与混合型命令)。

### 分发机制不进入业务层

解包、路径校验、版本目录和 active state 更新属于 `cli/src/plugin` 宿主边界；`packages/plugin` 只定义
Plugin 与 Service 公共语义，collect 只消费注入的 `PluginDefinition`，本地 agent loop 只消费解析后的
Skills。归档来源只负责取得交付物，不影响 Catalog 或诊断领域实现。

### 归档是受信任代码，但仍需安全解包

Plugin 与 Doctor CLI 同进程运行，拥有相同的文件、网络和凭据权限；Plugin 不是安全沙箱，只允许加载
来自受信任交付渠道的 Plugin。解包仍必须拒绝绝对路径、`..` 穿越、符号链接逃逸和越出插件根目录的
manifest 入口，并使用临时目录加原子 rename，避免半安装状态。签名校验和私有仓库属于归档来源与信任
能力，不改变本地安装模型。

### 非目标

- Marketplace、在线搜索或自动升级；
- Package / Instance / Binding、独立 Runner 或插件间依赖解析；
- 同版本原地覆盖、运行中热更新或动态卸载；
- 客户现场依赖安装和 install script；
- CLI 到远端执行环境的隐式 Skill/Plugin 上传。

### 同一实现支持 tar 与定制 binary

企业 Plugin 的 workspace `package.json` 可只服务开发和构建，保持 `private: true`，不发布 npm。
标准交付把自包含 `plugin.mjs` 与 Skills 打成 tar，由通用 Doctor binary 安装并在 Host 上加载；需要定制 binary 时，
分发方可从 `doctor-cli/embed` 导入 `startDoctor`，提供独立 composition entry，并通过
`cli/Makefile` 的 `DOCTOR_ENTRY` 构建。本仓根 `make build/install` 始终构建不带具体 Plugin 的通用 CLI。
两种形态共用 `PluginDefinition` 与 capability，差别只在启动时如何取得 Plugin。

定制 CLI 的名称、描述和命令展示由 [Distribution](distribution.md) 表达，通过 `startDoctor`
的发行配置注入；它属于发行装配，不进入 Plugin 业务协议。

### Service Overview

`overview.summarize` 与 `overview.sample` Extension 声明静态 Facet 和动态 Entry 的 `summarize` / `sample` 方法。Entry data 可以是数值或
文字，`canSample` 决定是否可进入可选采集。Core 负责时间窗口、展示、用户确认、跨 Service 样本去重及
Collect 编排；Plugin 负责匹配条件、统计口径与代表请求选择。详见 [Overview](commands/overview.md)。

Plugin Kubernetes `exec` 支持 stdin 和不超过宿主上限的 timeoutMs；凭据与协议参数应走 stdin，
不得放入命令参数。取消信号、权限检查及资源生命周期继续由宿主管理。

### Extension 与 Data 接入

Service.extensions 提供开放 kind 的 Extension；Extension、kind 标识及各 kind 的输入输出契约统一定义在
`packages/plugin`。Catalog 按 kind 离线发现，不调用实现；Extension.access 声明实际访问需求。
Data 使用 facts.inspect，prepare 先检查所选实现权限，run 再通过宿主的受限上下文取数。输入是 Query
列表，输出逐 Identity 关联，复用既有 Fact 与预算校验；它无需数据库式 resolveTarget。

Service 的其它 kind 不扩大 Data 的权限范围；当前 Data 每个 Service 只接受一个 facts.inspect 实现。\n通用扩展协议见 [Extension](extension.md)，Data 领域规则见 [Data](commands/data-diagnosis.md)。

### Inspect 批量调用

`FactsInspectExtension.run(context, queries)` 返回 `ServiceInspectQueryOutcome[]`。每个输入 Identity 恰好有一个
collected 或 failed outcome，成功项携带原有 `ServiceInspectResult`；未找到记录仍通过 resolution 表达。
Core 负责遍历、分批、去重和预算，Plugin 负责本 Service 的批量数据访问。provider 在整批开始时准备共享
Client / Repository，按数据源能力合并或逐条查询，并隔离各 Query 的查询失败。共享准备失败可拒绝整次调用，
由 Core 为本批每个 Query 记录失败；取消信号继续向上传播。单 Query 是一个元素的列表，空列表不访问外部资源。
