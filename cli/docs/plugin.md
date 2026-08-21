# Plugin 分发

## 理念 / 概念

Doctor Core 保持开源，但具体 Plugin 的 Service Catalog、固定查询和排障知识可能属于企业内部资产。
Plugin 通过版本化、自包含、可离线交付的归档分发这些业务扩展，同一份交付物同时贡献：

- **PluginDefinition**：向确定性诊断提供 Service Catalog 和插件级 capability，并在运行时携带同版本
  已解析的 `PluginSkill`；
- **Skill 资源**：采用标准 `SKILL.md` 目录，供本地 `doctor chat` 的 agent loop 渐进加载业务知识和脚本。

Plugin 是 Service 与 Skill 的打包和分发单位。`PluginDefinition` 是唯一运行时入口，`id@version`
构成其精确身份，其中
Service Catalog 可包含组成同一应用的多个 Service，每个 Service 各自声明 capability、所需 access
以及对其它 Service capability 的运行时依赖；
同一 Plugin 也可携带多个 Skill。Plugin manifest 只定位代码和 Skill，loader 再把已解析的 Skill runtime view 附到
`PluginDefinition.skills`，不重复声明 store、log、data、model 等能力。
例如业务 ID 到规范 `trace_id` 的转换由 Service 的 `traceId` capability 声明：一个业务 ID 可返回一条
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

Doctor 与 Plugin 的运行边界围绕 capability 调用展开：Plugin 声明自己能提供哪些 capability；Doctor 在每次调用时
告知当前 profile 选择的 Target 和 Target-scoped access；Plugin 返回对应 capability 约定的结果，使
Doctor 能够统一串联、诊断和展示。Core 负责通用 Host/Target 访问和 Doctor-owned operation，Plugin
负责业务目标与数据语义；业务 HTTP/数据库协议仍属于 Plugin，但 Kubernetes 传输和 port-forward
生命周期不由 Plugin 重建。
当操作依赖原始凭据或厂商私有配置时，Plugin 可以返回“规范化身份 + 操作方法”的临时 handle；
Core 只持有并调用 handle，不要求 Plugin 把敏感配置翻译成公共字段再传出。

capability 是 Core 发现、准备和调用 Plugin 能力的中心。下面五类契约只服务于 capability，不各自形成
Plugin 扩展点或生命周期：

| 协议面 | 方向 | 所有权 |
|---|---|---|
| access | Plugin capability → Core | Plugin 声明最小需求，Core 合并、预检并执行策略 |
| dependencies | Service → Core | Service 引用同一 Plugin 中其它 Service 的 capability，Core 验证并准备运行时 handle |
| data | Core ↔ Plugin capability | 公共包定义类型化输入输出；私有 schema 留在 Plugin 内 |
| infra | Core → Plugin context | 当前 Target 的 Kubernetes access、取消与资源生命周期等运行便利 |
| config | profile/Core → Plugin context | Core 不透明保存和透传，schema、校验和解释归 Plugin |

这五类不能互相代替：infra access 不代表 capability 已获授权；config 不承载 kubeconfig 等 Core-owned
连接状态；data 返回值也不用于把 Plugin 私有配置整包泄露给 Core。

Core 与 Plugin 使用同一套 Capability 词汇；Plugin Service 只是业务 Capability 的归属与提供单元，不形成
第二条扩展流程。Inspect Capability 遵循 `Query → Capability → Fact`：Query 由类型化 Identity 与该
capability 的约束组成；Relation 是一种 Fact，表示 Plugin 已从现场数据确认的 Identity 关系。
Capability 不归属某个 command，同一份 Fact 可以被多个诊断入口消费；是否沿 Relation 继续查询、
查询边界以及如何组织 Evidence 始终由 Core Command 拥有。summary/table 等展示投影不能参与 Query 调度。

Probe Capability 遵循 `Input → Capability → Observation`，提供业务协议的一次执行原语。调用方每调度一次，
runner 执行一次；循环、并发、依赖、预算、停止条件、Operation 授权和 Evidence 均由 Command 或 Harness
拥有。Command 内部的 Probe 调度节点既可使用 Core 通用实现，也可适配 Plugin 的 Probe Capability；主动
inference、Case 和运行时取证因此返回 Observation 或临时 handle，不伪装成 Fact。
Inspect Capability 必须通过 `accepts` 声明可消费的 Identity kind；Command 据此选择 Capability，不能通过
试调用或解析展示结果猜测兼容性。一次 Query 只携带一个 Identity，批量、遍历和失败隔离属于 Command。

Service dependency 用于 capability 归属和访问信息归属不同的场景。例如一个逻辑 OpenSearch
Service 可以提供业务查询 capability，但实际 endpoint 和凭据来自另一个业务 Service 的 Store
capability。依赖因此挂在消费方 Service，而不是塞进某个 capability 实现或复制一份连接配置。
Core 在调用 capability 前解析依赖，只向 `PluginContext` 注入受限的操作 handle；凭据、
port-forward 和清理仍归 Core 拥有。

Trace Capability 把采集定位和纯分析明确分开：`trace.source.store` 引用 Service Catalog 中的首选 Store；
Core 在运行时解析实际 OpenSearch target，并在首选项不可用时尝试 Catalog 中其余 OpenSearch VDB Store。
`trace.analysis` 直接采用 trace-harness 的
`TraceContributions`，只对已标准化的 Trace IR/Facts 做确定性 feature、detect 与 render 扩展。它不读取
profile config，不持有 infra，也不访问外部资源；诊断流程和 TraceHarness 实例生命周期仍由 Core 拥有。

Model Capability 是 Plugin 对模型域的聚合声明：tenant directory 与 model catalog 构成模型消费者共用的
发现能力，`inferenceService` 只在 Plugin 支持主动模型调用时声明。Chat 用它选择并调用 LLM，
`doctor model` 在同一数据契约上执行 validation、performance 和 Evidence 编排。Core 在调用前
检查 Kubernetes access 并提供 port-forward，Plugin 持有业务路由与凭据；inference factory 只有在
所需连通性准备完成后才返回 handle，因此 Chat 不会在首轮请求时才发现连接尚未建立。

Tenant Capability 只绑定租户目录，不再定义 Command-specific contribution。`doctor tenant` 解析
`tenant_id` 后直接复用 Model Catalog，并选择 `accepts` 包含 `tenant_id` 的 Service Inspect Capability；
返回的 Model 或每个 `ServiceInspectFact` 作为独立 Fact 进入 Tenant Evidence。相同 Capability 仍可被其它 Command
复用，Tenant Command 只拥有本次选择、失败隔离、Coverage 和展示。

公共 `Model` 是可落盘的安全模型清单：可承载身份、可用性、规格、capacities/features、计费摘要和时间
信息，但不承载 API key、AK/SK、access token、额外请求头/请求体或厂商私有原始配置。Plugin 应只映射
公共字段，Core 在写 Evidence 前还会按同一白名单重新投影，防止 runtime 对象的额外属性随结构赋值泄漏。

Case Capability 是 Service 的 Probe Capability，提供稳定请求资产与单次执行协议。它暴露一个或多个 CaseSet，以及并发安全的
单次 Case runner；Case 与 CaseSet 的 canonical schema、校验和类型均归 spec-case，Doctor Plugin SDK
直接引用该资产模型，不复制子集或维护第二套 schema。环境地址、身份和凭据由 runner 从 Plugin context
取得，不写入 Case。`doctor eval` 顺序调用 runner 的 `run` 并采集每次 Observation 的关联证据；`doctor perf`
在 Perf Harness 的 dispatch 点并发调用同一 runner。Capability 不为任一 Command 内建隐藏循环。

Perf Capability 是其上的场景预设，只选择 CaseSet 中的一个或多个 Case、声明本次权重、业务关联键
优先级和 Metric/Log Service。权重属于本次 Experiment，不属于 Case。并发模型、dispatch、
Stage/Window、请求预算、熔断、Outcome IR、`by_case` 统计和报告编排由 Core 与共享 Perf Harness 拥有。
Core 在每个调度点调用一次 runner，Plugin 决定这次调用如何变成真实 HTTP/SSE 请求，可以持有 Trial 级
setup/deactivate/cleanup，但不得另起不可记账的发压循环。这样 runner 还能被单 Case 调试等入口复用。

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
  "pluginApiVersion": 3,
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
取消信号和 Target-scoped Kubernetes access。Plugin 用 access 读取 Service、定位 Pod 或访问其它资源，
Core 不接收再回传 Plugin-owned 的 selector 等实现细节。profile 切换后，Doctor 在下一次调用中注入新的
上下文，Plugin 不持有 kubeconfig 或旧环境选择。

Service capability 的输入只由两部分组成：Core 已知且受控的 `PluginContext`，以及该
capability 实际需要的业务输入。`PluginContext` 可以携带 profile 环境、当前 Target namespace、
已选逻辑 Service、Plugin-owned config 和受 access 约束的 infra；Core 不应为了调用 Service，
先猜测其部署 namespace、Pod 或业务数据位置，再把这些 Plugin-owned 事实回传给 Plugin。

当逻辑 Service 的配置来源不在当前 Target namespace 时，Plugin 可以通过 Kubernetes access 的
`inNamespace` 在同一 Target cluster 内自行发现，并为跨 namespace 操作声明 `allNamespaces`
access。当前 namespace 是 Core 已知的调用上下文，不是逻辑 Service 必须同名部署于此的假设。
例如 VDB Store capability 可由 `inspectTarget(context)` 自行定位配置来源，再向 Core 返回统一的
`ServiceVdbTarget`；Core 只消费这个结果完成标准 VDB 诊断。

网络 endpoint 跟随实际消费它的 capability 声明，不放在 Service 根上假设一个全局端口。同一 Service
可以分别为 tenant directory、model catalog、inference、MCP 或 metrics 提供不同 endpoint；命令只为
本轮选中的 capability 建立对应连接。

Kubernetes 传输以及 port-forward 的本地端口分配、取消和回收具有明确的 Doctor 调用生命周期，因此由
`PluginContext` 按需提供。HTTP、数据库客户端由 Plugin 实现；SDK helper 只承载稳定且跨 Plugin 同义
重复的代码。协议不注入 Doctor 的 `HttpTransport`、`Database` 等具体实现。Service 定位规则、API、
SQL、表结构及诊断知识始终属于具体 Plugin。

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
