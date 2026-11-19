# Plugin 分发

## 理念 / 概念

[Service 声明与接入](service.md) 说明 Catalog 中的服务身份、Workload、资源、Case 与 Operation。

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
例如输入 ID 到规范 `trace_id` 的转换由 Service 的 `trace.resolve` Extension 声明：输入可为业务 ID 或
trace ID，由 provider 判定类型；一个输入可返回一条或多条 trace resolution，并可携带直接承载 trace 的来源 ID。
`trace` 消费规范解析结果；`log` 将 trace 作为一种 key，还可通过声明的 `data.id` 关系取得其它 key，
不读取私有 record/value 字段或 span tag 猜测关系。批量调度和按 ID 分组交付由 Core 负责，见 [Log](commands/log.md)。

monorepo 中的源码按依赖方向分为三层：

```text
cli/src/plugin/              Plugin 安装、选择与加载的宿主边界
packages/plugin/             doctor-plugin 协议与可选共享 SDK
plugins/<plugin>/            可独立构建、归档和分发的具体 Plugin 实现
```

领域依赖保持 `cli/collect -> packages/plugin <- plugins/<plugin>`。CLI core 只接收注入的
`PluginDefinition`，不引用具体 Plugin；根目录发行构建和 Host loader 分别负责在编译期、运行期
取得具体实现，collect 不感知来源。

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
  "pluginApiVersion": 18,
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

`doctor plugin` 是离线发现入口，展示采集命令实际使用的 Plugin 与 Service Catalog，支持 text/json/summary。
它复用“入口注入优先，否则加载 Host active 版本”的规则，不扫描未激活版本，也不准备 profile、
调用业务 capability 或访问目标环境。来源 `injected` 表示由 composition root 提供（通常是内嵌，
也可能是调用方动态加载），`installed` 表示本机激活的安装版本。Service 的 Extension/Detector
名称直接投影自声明；这些名称不是 CLI 命令清单，Catalog 存在也不代表现场可达。

`doctor plugin --service <name>` 按逻辑 Service 身份筛选并展示详情；未知 Service 报错，不返回伪装成功的
空目录。未筛选时 JSON 的服务索引包含名称、别名、简短介绍与 `upstream`；筛选后展示诊断
`details`。`upstream` 是该 Service 的调用方名称列表，未声明和显式空列表分别表示未知与无上游。
它是静态关系，不代表现场调用链、健康状态或访问计划。

Plugin 通常对应一个 Product，以 `ServiceCatalog` 表达组成，并作为 `id@version` 标识的装配和
分发形式交付 Service、Knowledge 与 Skill。Plugin 与 Service 均通过 Common 的可选 `knowledge`
声明概念、流程、文章与词典；知识阅读统一使用 [doctor knowledge](commands/knowledge.md)。

Knowledge 只记录业务知识，包括业务概念、规则、服务机制与领域约束。CLI 的命令语法、参数、
默认值和输出格式统一通过对应命令的 `--help` 获取，不写入 Knowledge，避免重复维护命令帮助。

原来独立的 `concepts`、`workflows` 文本字段迁入结构化 Knowledge，每个知识对象通过 `markdown()` 提供文本，父对象调用子对象方法组合。JSON 加载方须补齐方法后再声明 Knowledge。

`doctor plugin` 展示 Plugin 身份、说明与服务索引，指定 Service 后仅展示所属 Plugin 身份与服务声明。
文本、Summary 和 JSON 均不展开 Knowledge。`-f summary` 只展示身份、别名、说明与上游关系；
默认 `text` 和显式 `json` 在指定 Service 时包含诊断能力声明。输出无需准备 profile 或 Target 访问。

```bash
doctor plugin
doctor plugin --service <name> -f summary
doctor knowledge --service <name>
```

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

## Service 契约索引

- <a id="service-与-workload-的公共模型"></a>[Service 与 Workload 的公共模型](service.md#service-与-workload-的公共模型)
- <a id="service-身份与别名"></a>[Service 身份与别名](service.md#service-身份与别名)
- <a id="core-与-plugin-service-的职责"></a>[Core 与 Plugin Service 的职责](service.md#core-与-plugin-service-的职责)
- <a id="执行阶段分工"></a>[执行阶段分工](service.md#执行阶段分工)
- <a id="协议负责能力对接sdk-负责代码复用"></a>[协议负责能力对接，SDK 负责代码复用](service.md#协议负责能力对接sdk-负责代码复用)
- <a id="service-overview-与-health"></a>[Service Overview 与 Health](service.md#service-overview-与-health)
- <a id="extension-与-data-接入"></a>[Extension 与 Data 接入](service.md#extension-与-data-接入)
- <a id="redis-source"></a>[Redis source](service.md#redis-source)
- <a id="service-resource"></a>[Service Resource](service.md#service-resource)
- <a id="service-endpoints"></a>[Service Endpoints](service.md#service-endpoints)
- <a id="case-与-operation"></a>[Case 与 Operation](service.md#case-与-operation)
- <a id="inspect-批量调用"></a>[Inspect 批量调用](commands/data.md#inspect-批量调用)
- <a id="fact-的摘要展示"></a>[Fact 的摘要展示](commands/data.md#fact-的摘要展示)
- <a id="inspect-来源采集结果"></a>[Inspect 来源采集结果](commands/data.md#inspect-来源采集结果)
- <a id="inspect-查询时间窗"></a>[Inspect 查询时间窗](commands/data.md#inspect-查询时间窗)
