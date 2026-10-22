# Service Inspect

## 理念 / 概念

`doctor inspect` 以 Service 为检查对象，形成两类彼此独立的现场事实：Service 的运行载体（workload）与 Service 的配置。Service 通过静态 `dataSources` 声明配置文件；基础 workload 检查不依赖文件声明。

- **Workload runtime**：Service selector 当前匹配的 Pod、Container、镜像、CPU/Memory requests/limits、就绪状态、重启次数和上一次终止原因。`OOMKilled`、exit code 与 `CrashLoopBackOff` 等状态作为现场事实展示，不把资源声明误写成实际使用量，也不把退避状态误写成根因。
- **Workload 声明**：Service 提供的可选 `description` 说明负载用途；报告和目标 Fact 保留它，缺少 Pod 时仍可查看，不将说明当作现场可用性证据。
- **Toolchain**：Plugin 对 Service 的源码语言、执行平台、依赖管理器与构建工具声明。它用于选择通用采集器，不冒充当前 Pod 的现场事实。
- **Deployment 配置（可选）**：用户确认后，读取 Kubernetes Deployment 为业务 Container 声明的环境配置，包括 `envFrom.configMapRef`、`env[].valueFrom.configMapKeyRef` 与显式 `env`。通常 ConfigMap 承载普通配置，显式 Deployment env 承载密码、密钥等配置。这是部署声明；现场环境变量通过 `--field env` 单独读取。
- **Runtime dependencies（可选）**：用户确认后，由 Core 进入代表 Container，按 Toolchain 选择语言采集器并取得实际依赖与版本。依赖清单可能包含内部包名，因此与 Env 分开授权。
部署配置报告按不区分大小写的配置名归并；字段查询保留每个来源。租户配置属于租户粒度，由
[`doctor tenant`](tenant.md) 汇总，不与 Service/workload 配置混在同一报告中。

## 流程

1. app 注入当前 `PluginDefinition`；Service 选择从 Plugin Catalog 与当前 Namespace 实际 Service 求交集。Service 选择完成后，交互分别询问是否采集 Deployment Env/ConfigMap 和应用依赖；非交互命令只有显式传入对应 flag 才采集。
2. `service-targets` Inspect 始终读取 Namespace 中的 Service 和 Pod。只有用户确认后才读取 Deployment 和 ConfigMap；Service selector 同时定位其当前 Pod 和对应 Deployment。
3. Inspect 将每个所选 Service 的 Pod、Container 状态、重启/终止原因、镜像与资源声明记为独立 Fact；Pod 列表权限或解析失败时保留其它配置证据，并在 Coverage 中标明缺口。
4. 用户确认时，部署配置 Probe 解析目标 Container 的 ConfigMap 与 Deployment env。显式 env 按 Kubernetes 语义覆盖同名 ConfigMap；Secret 引用不读取 Secret 对象。未选择时不发起这两类 Kubernetes 查询，标为未纳入范围，不计入缺失证据或不足的 Coverage。
5. 用户确认依赖采集时，Inspect 用 Service selector 与 port 定位业务 Container，按实际 `imageID` 去重后每个镜像选择一个 Running Pod。Core 根据 Toolchain 执行有界只读采集，只保存归一化后的包名、版本和现场 runtime version；拒绝后不申请 `pods/exec` 权限。
6. HTML 和 Markdown 分别展示 Workload 声明、Pod、Toolchain、应用依赖与 Service 配置；Workload 说明和 Toolchain 明确标为声明，依赖与 runtime version 明确标为本次现场观测。
7. 报告状态按本次选择的范围计算；只采集 Pod 运行态不因未开启可选项而变为 partial。已选择的目标采集不足仍保留真实缺口。完全没有形成可用证据或交付失败时才回退失败 Evidence Bundle。Kubernetes 原始响应不落盘，报告只保存归并后的事实。

`-y/--yes` 禁止全部交互，包括 Service 选择与可选采集询问；缺少 `--service` 时在 Plugin
加载和环境连接前报参数错误。`-y` 不开启可选采集，需显式传 `--deployment-config` 或
`--dependencies`；对应 `--no-*` 表示明确关闭，即使恢复交互也不再询问该项。

## 快速查看字段

```sh
doctor inspect -s api --search sandbox
doctor inspect -s api --field env --search SANDBOX
doctor inspect -s api --field config --search sandbox -f summary
doctor inspect -s api --field image
doctor inspect -s api --field image --search registry.example.com
doctor inspect -s api --field event --since 30m -f summary
doctor inspect -s api --field hpa -f summary
```

`--field env|config|image|event|hpa` 选择要采集和查看的信息；不带关键词时返回该字段的全部条目。
`--search` 对 Env 名称或值、配置键或值、镜像地址或 Image ID 做忽略大小写的字面子串匹配；
单独使用 `--search` 默认搜索 env。关键词不作为正则表达式，也不拆词；首尾空白会移除，
空白关键词报错。结果保留原值和 Service、Workload、Pod、Container 来源。

Env 查询通过 `pods/exec` 在每个 Pod 的业务 Container 内执行 `printenv -0`，读取现场环境变量；
包括镜像 ENV、Kubernetes 注入值和已注入容器的 Secret 值。不会额外读取 Secret API。
按 Workload 声明或 Service port 定位业务 Container，每个副本独立采集，不按镜像合并。
缺少权限、Container 未运行、业务容器无法唯一定位或 printenv 不可用时，在 Coverage 中保留缺口；
不会用 Deployment/ConfigMap 的声明值替代。NUL 分隔保留值中的换行和等号。

指定 `--field` 时，只采集该字段与必要的 Workload/Pod 定位数据，不运行其它 Service Probe/Detector。
Env 只读取 Pod env，Config 读取声明的文件组和 Pod env，Image 使用 Pod 镜像声明与 imageID，
Event 只额外读取关联事件，HPA 只额外读取关联 Autoscaler。它们不互相附带采集；
`--search` 未指定 field 时仍等同于 env。字段选择同时约束权限预检、实际访问和 Coverage。
`--field/--search` 不能与 `--deployment-config` 或 `--dependencies` 同时使用；完整 Inspect 才支持这两个额外采集开关。
部署配置仍表示声明，Env 搜索只匹配容器现场观测值。

Event 保留现有的 Warning/生命周期 Normal、时间窗及容量规则；结果含时间、级别、对象、原因、次数和消息。
事件只关联本次定位的 Pod 与已知 Workload 对象，不为关联 HPA 自身事件额外读取 HPA。
HPA 展示目标、当前/期望副本、min/max 与指标；两者的 `--search` 均按值忽略大小写匹配。
读取或解析失败形成字段证据缺口；成功返回空列表表示本次未匹配到对象，事件截断则保留 partial。

没有指定 format 或 output 时默认在终端显示结果；显式指定交付格式时沿用该格式。
Config 的 Markdown 摘要按文件/Pod env 分组，每组一个“名称 / 值”表格。
同一 Service、Namespace、来源类型和路径下，本次匹配内容完全相同的来源合并展示；
组头保留全部 Workload、Pod 与 Container，值有差异时单独成组。
相同匹配项不表示未匹配的文件内容相同；JSON 和完整证据仍逐来源保留。

结构化结果保存在 `analysis/evidence.json` 的 `search` 字段中，包含 field、可选 keyword 和 matches；
JSON 交付通过证据引用关联该文件。字段范围内的完整 Facts、Observations 和 Coverage 不受关键词过滤影响。
采集完整但没有匹配时成功返回空结果；采集不足时保留缺口，不将其解释为目标值不存在。

Env 表示容器内新执行进程观察到的环境，不展开挂载 YAML/JSON，也不声称反映应用启动后在进程内修改的环境变量。
Image 来自发现的 Pod Container 声明及 imageID，不表示 Registry 当前 tag 指向的镜像。

## 终端运行摘要

使用 `doctor inspect --service api -f summary` 直接打印紧凑摘要。
完整证据仍落盘，但终端不显示原始证据链接、证据导航或目录提示；需要证据索引时使用 `-f manifest`。
Summary 不生成 HTML，不支持 `--output`；它与其它格式使用相同的采集范围。
`summary` 统一隐藏连接成功、权限检查和采集进度等 info/success 日志，保留 warn/error；
结果摘要使用独立 writer，正常输出。

Pod 总数按环境、namespace 和 UID 去重，异常明细保留 Service/Workload 关联。Ready 数量只表示
当前就绪状态，历史重启或 OOM 不减少 Ready 数量。状态含义如下：

- `degraded`：存在当前 Pod/Container 异常，或 Detector 给出了 warning/critical 发现。
- `unknown`：尚未观察到上述异常，但本次请求范围内的证据不完整，或没有可判断的 Workload。
- `warning`：当前实例正常、证据完整，但存在历史重启或终止记录。
- `healthy`：证据完整，且未发现上述异常或历史提醒。

摘要单独显示证据完整性及缺口，因此已知异常和缺失证据可以同时呈现；Detector 发现也会列出。
未启用的可选配置、依赖采集不计入证据缺口。内存 request/limit 是资源声明，不是当前使用量。

## 关键设计

### Kubernetes 访问与观测复用

Core 的资源查询和 Plugin 借用同一个 Command 持有的 KubernetesClient，复用原生 HTTP
连接池；资源证据记录实际 API request、observedAt 和耗时，不伪装成 kubectl 命令。
单次 Inspect 内复用成功观测；完整、无筛选的列表可提供同 namespace 下的已存在对象。
有分页后续或带 selector 的列表不会被当作完整快照，失败不缓存，跨 Command 不复用观测。
复用的证据保留原观察时间，并标记 reused，不能解释为再次访问了 API。

文件目标解析借用同一个 Inspect 观测集，仍逐个检查来源声明的资源、API group 与 namespace 权限。
相同查询复用已取得的结果；不从无关 selector 的列表推断另一查询。
Pod env 仍逐副本采集，文件按 source 声明的组采集，Probe 顺序与并发保持不变。exec 使用根客户端的流式通道；
它与资源 HTTP 连接池共享根生命周期，但每次命令都有独立会话，不重放失败的命令。
WebSocket 握手需要 get pods/exec 权限；Plugin 声明 exec 能力时，Core 补充检查这一传输权限。
Bun Host 暂不支持 kubeconfig proxy 下的原生 exec，会在执行前明确报错；这种配置需使用 Node Host。

### 文件声明与运行时读取

`Service.dataSources` 是静态数组。Plugin 使用 `fileDataSource` 声明非空、无重复的路径数组、所属 Workload、
访问需求和目标解析函数；发现 Catalog 不定位 Pod。Core 创建客户端时注入
`PluginClientContext`，initialize 解析代表 Pod/Container，read 通过 Quality Harness
`PodFileDataSource` 一次 exec 读取整组。同一 source 只定位一次目标；不同 source 的定位查询
可以复用本次 Inspect 已取得的观测。根 Command 统一复用与释放客户端。

`--field config` 同时查询 Pod env 和声明的 YAML/JSON 文件。每个文件最多 1 MiB，
每组总预算为路径数 × 1 MiB，整组读取限时 15 秒（含排队）；嵌套键展开为 `sandbox.provider.config.endpoint`，数组为 `items[0]`。
结果保留 Service、Workload、Pod、Container 和文件路径，不合并文件/Secret overlay/env 的优先级，
也不导入 Settings 或声称得到应用解析后的最终配置。无文件声明的 Service 仍查询 Pod env。
文件通常取一个代表 Pod，而 env 逐个副本采集，报告保留实际来源。

每个声明路径均形成独立 Observation 与 Coverage 期待项；文件不存在、无权限、超限或解析失败只形成
该文件的证据缺口，其它文件保留。无法定位目标、整组超时、总预算或传输失败标记整组缺口。
文件组共同读取不承诺文件系统原子快照，也不把 env 合并进文件组。
有效空文件与读取失败分开处理。解析错误不包含文件原文。只查询 env/image 不读取文件。
`configurationInspection` 已移除，不再控制采集范围。

### 为什么 Env/ConfigMap 需要单独确认

Pod 数量、镜像和资源声明是常规工作负载事实；Deployment env 与 ConfigMap 则可能直接包含密码、密钥等业务数据。Doctor 在 Service 选择后单独确认，只有用户明确需要时才申请相关读取权限并采集。未选择的 Env 目标不计入 Coverage；已请求但失败的采集仍标为不充分，避免把范围选择混为执行失败。

### 为什么 Toolchain 由 Plugin 声明、依赖由 Core 采集

Service 拥有自己的源码语言和构建方式，Plugin 最适合声明这些稳定知识；进入 Container、控制权限与预算、解析通用语言依赖并形成 Evidence 则是 Core 的标准基础设施职责。Toolchain 只帮助 Core 选择采集器，实际镜像、runtime version 和依赖仍从 Target 观察，避免 Plugin 版本滞后时把期望状态误报成现场状态。

### 为什么依赖单独确认并按镜像采集

依赖清单可能暴露内部包名，而且需要 `pods/exec`，不能跟随普通 Pod 列表隐式发生。依赖属于构建产物而非 Pod 副本；同一 `imageID` 的多个 Pod 只需选择一个代表实例，既保持证据身份准确，也限制远端执行次数。

### 为什么 Pod 运行态与 Service 配置分开展示

Pod 数量、镜像和资源声明回答“所选 Service 当前落到了哪些工作负载”，Deployment Env/ConfigMap
回答“这些 workload 声明了什么 Service 配置”。二者更新节奏与缺失原因不同，拆成独立 Fact、Coverage
和表格后，Pod 权限不足不会掩盖已经取得的配置证据，也不会把 requests/limits 误解为资源使用指标。

### ConfigMap 与显式 env 的关系

大多数部署不会在 ConfigMap 和显式 env 中声明同名配置。若意外重复，Doctor 仍遵循 Kubernetes 的确定性优先级：显式 `env` 覆盖 `envFrom` 引入的 ConfigMap 值，并在 Env 列中只保留一个结果。

## 事件时间窗

`--since`、`--since-time`、`--until-time` 限定历史事件范围；Pod 状态仍是本次采集的当前快照。
保留 Warning 与启动、重启、扩缩等相关 Normal 事件，包括镜像 Pulling/Pulled。
重复事件按发生区间与窗口相交保留。证据保存首次/最近发生时间、采集时间及容量截断数；
未指定窗口时不额外限制为一小时。空结果只表示当前 API 查询未返回相关事件。
