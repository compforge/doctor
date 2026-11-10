# Log 采集

Doctor 从 Plugin Service 的 Workload 声明定位日志实例，再通过共享 Client 读取 Pod 日志；逻辑 Service 名不作为 Kubernetes 资源名。不带业务 ID 时采集时间窗口内的日志，不调用 trace resolver 或准备其业务依赖；带 ID 时搜索关联 trace 及 Plugin 声明的对象日志，全部解析失败不会降级成无过滤采集。某个 Pod 命中只触发即时反馈，不减少其他 Pod 的覆盖；current 与可用的 previous 容器日志都保留来源。

```bash
doctor log                         # 默认 Service / 时间窗口；交互时可选择 Service
doctor log --service api -n prod --since 15m
doctor log --service api --pod api-abc --container app --since 15m
doctor log --service api --since-time '2026-09-16T15:00:00+08:00' --until-time '2026-09-16T15:15:00+08:00'
doctor log <biz-id> --since 15m      # trace 与已解析对象关联
```

`--service` 和时间起点都可省略：非交互以注册了 `log.workloads` 的 Service 为候选，交互沿用 Service 多选；无 ID 使用默认回看窗口。`--errors-only` 和 `--pattern` 在两种模式下均可用。

## Workload 与采集范围

Service 可以声明多个 Workload，位置可以是 Kubernetes Service、labels 或具体资源。Core 解析其 Pod（包括已终止的 Pod），
并按声明的 container 采集；未限定 container 时采集 Pod 的 application containers。交互候选来自 Plugin Catalog，
不要求逻辑名称与集群 Service 同名。没有 Workload 声明、没有实例或定位失败都形成明确的证据缺口，
不回退为同名资源查询，也不抹掉其它 Workload 已取得的日志。

`--pod` 与 `--container` 按完整名称缩小上述范围，不绕过 Workload 的 container 声明。找不到目标会报告证据缺口，不回退采集其它实例。读取自动包含 current 与可用的 previous（上一次重启前）日志，无需额外开关；Pod 已删除或日志已回收时无法恢复，读取失败会保留原因。

每次命令仍限定一个 namespace。Workload 声明其它 namespace 时提示用 `--namespace` 单独采集，
不会静默切换目标。Manifest 的 Inspect Facts 保留 Service → WorkloadInstance 关联和定位缺口，
包括环境、namespace、Pod UID 与 container；重叠声明保留各自来源，读取计划按实际容器去重。

每个候选 Service 可通过 `log.workloads` 返回本次输入相关的 Workload 子集。空列表表示无需采集，
不会定位对应 Pod 或下载日志；查询失败记录缺口，其它 Service 继续。显式选择未提供此扩展的 Service
时使用其静态 Workload。批次中的每个业务 ID 独立选择，选择结果与摘要保存在日志归档的 diagnosis.json。

## 对象关联日志

Service 的 `logs.identityRelations` 声明可用于日志关联的有向身份边；Core 复用 Data Command 的
`facts.inspect` 查询、预算和获取状态，从输入 `biz_id` 沿这些边选择身份，仅匹配声明该规则的 Service 日志。
Plugin 不应声明共享资源到其它会话/运行实例的反向边，避免把同 Carrier 的兄弟会话扩大为当前查询目标。
Core 不读取 opaque record/value 内的业务字段，也不直接把未解析的输入当成搜索关键字。

有 trace 或关联对象任一证据即可采集；关联查询不完整时保留日志并报告 partial，相关 Data 证据作为子结果交付。
无业务 ID 时不执行这次查询。时间窗、字节预算、current/previous 和错误堆栈规则继续共用原日志流程。

`timeline.jsonl` 的 `matches` 分别记录 `trace` 和 `related-object`，后者保存身份、queryId 及 relation factIndex，
可回到子 Data 的事实快照核对。TXT 和 HTML 同样标注匹配依据。共享对象命中只表示相关线索，不代表日志属于该请求。
previous 未过滤尾部仍显式标为 unfiltered，不添加匹配依据。

## 时间范围与读取

显式 `--since-time` 优先于 `--since`；未指定时按下述自动采集窗口规则推导。可靠的日志终点可通过 `--until-time`（RFC3339）传入，终点包含在范围内。显式指定起点/回看时长，或无 ID 且省略终点时，终点固定为命令准备开始时刻，不持续跟随；该快照边界不是业务请求结束时间。未指定窗口的带 ID 查询，不从 ID 或采样 Trace 猜测请求结束时间。只指定历史终点时，默认回看范围以该终点为基准。

Kubernetes Log API 只接受时间起点。Doctor 按容器运行时日志时间戳读取，遇到第一条超过终点的记录后关闭流，并将该请求范围记为正常完成。时间范围依赖容器日志按运行时时间排列；终点外的记录不进入结果。范围内的异常首行和堆栈续行仍组成一个逻辑日志事件。

### 自动采集窗口

用户显式指定时间范围时不自动加余量。未指定时，Doctor 优先使用 Data 贡献的 `CollectWindow`，
其次使用本轮 `collect` 已取得的完整 Trace，最后沿用 UUIDv7 / 默认回看策略。独立 `doctor log`
不额外下载 Trace。窗口选择和默认策略见 [window.ts](../../src/collect/log/window.ts)。

Data 通过 `facts.inspect` 贡献 `collect.window` RecordFact，并在 Extension 的 `provides` 中声明。
[CollectWindow](../../../packages/plugin/src/collect-window.ts) 表达一个对象的活动范围：边界使用
RFC3339，包含端点，允许只贡献一端；两端未知时不贡献。业务方负责选择活动时间，Core 不猜测业务表字段。

只采用窗口身份值等于本次输入 biz ID 的贡献；关联对象的窗口不会自动传播到根 ID，也不会跨输入合并。
组合命令显式传递先前 Data 结果；独立 Log 在所选 Service 声明窗口贡献或日志身份关联时执行 Data。
窗口只约束范围，不赋予身份匹配权限：不能解析 Trace 或声明的日志身份时仍不进行无过滤采集。

缺失边界按如下规则补齐，再应用 padding：

| Data 贡献 | 补齐规则 |
|---|---|
| 起止边界完整 | 直接使用 |
| 只有起点 | 用完整 Trace 的结束时间；无可用 Trace 时用本轮采集开始时间 |
| 只有终点 | 用完整 Trace 的开始时间；无可用 Trace 时从终点向前应用默认回看窗口 |
| 没有可用窗口 | 完整 Trace 范围，否则默认日志策略 |

同一业务 ID 对应的所有已解析 Trace 均具有完整、有效的 spans 时，Trace 范围才可参与计算，
使用最早开始和最晚结束时间。补齐后起止冲突、无效时间、不支持的窗口版本或 padding 后溢出
会记录忽略原因，不静默交换边界；有效兄弟窗口仍可使用。所有 Data 窗口均被忽略时，
继续尝试完整 Trace，之后才回退默认策略。

余量优先级为显式 `--time-padding`、窗口贡献、profile `log.timePadding`、默认策略。
每个窗口各自选定正时长余量，向前后扩展后再合并，避免一个较短余量覆盖其它活动需要的上下文。
显式配置值无效时报错，不静默回退。

配置提供默认策略，命令参数表达本次输入，Data / Trace 提供推导依据；结果不写回配置。
采集日志和 `collection.json` 保留最终范围、贡献来源、边界补齐依据、余量来源及忽略原因，
原始业务记录仍保存在 Data 证据中。

## 采集流程

1. 确定 namespace、Service 和时间约束。调用 `log.workloads` 选择本次请求相关的 Workload；
   带业务 ID 时按声明解析 Trace 与关联对象，只为实际调用准备依赖，并由统一生命周期回收。
2. 批次共享 Inspect，解析 Workload 实例与 Container status，建立 Service → WorkloadInstance 关系，
   识别 current / previous 候选实例。每项请求按自己的 Workload、Pod 和 Container 范围投影 Facts 与缺口。
3. Probe 建立跨 Service 的有序读取计划，复用共享日志源和容量限制。命中即时反馈，结束后按计划顺序
   保存 Evidence，并为每个 Service 生成独立 Observation。
4. 共享 Facts 与各请求的 Observation 组成 Evidence，Detector 描述证据不足，Render 生成带来源的时间线。
   Log 不把日志文本模式直接解释成根因；Render 不继续访问集群。
5. 默认交付离线 HTML 和完整 Bundle。批量输入共享发现与原始日志源，但各自独立过滤、判定和交付。
   空 ID 列表形成一个服务窗口采集项，不伪造业务 ID；单个来源失败不抹掉其它可用日志。

### 传输与信任

Pod Log API 按 kubeconfig 中 cluster 的 `server` URL 选择 HTTP 或 HTTPS。HTTPS 复用 CA、
客户端证书、`tls-server-name` 和显式 TLS 校验设置；证书失败不降级协议或自动关闭校验。
共享 Client 负责传输、超时和取消，Core 负责实例选择、匹配与证据投影。

## 流式反馈与证据

每条流独立匹配 trace 或声明的对象身份；无 ID 时接收窗口内日志。首次命中立即报告来源，
不缩小其它实例的覆盖范围。报告最终按时间排序，避免为全局排序等待无命中的 Pod 才反馈结果。

### 调度与共享日志源

Service 是证据边界，读取计划是调度边界。Observation、Pod 失败状态和时间线按 Service 组织，
日志流通过整个命令树共享的并发池和字节预算调度，避免逐 Service 串行等待，也避免多个 Client 放大总容量。
容量、超时与重试策略由 [log-policy.ts](../../src/command/log-policy.ts) 及其引用的共享实现维护。

同一根执行内，访问目标、namespace、Pod UID、Container 实例和明确的时间范围相同，才复用原始日志源。
业务 ID 与内容过滤条件不参与源身份；current / previous、重建 Pod、重启 Container 和不同窗口不会混用。
相对时间起点或缺失实例身份时独立读取。没有指定终点时，复用首次采集的快照，不代表持续刷新。
读取前后核对实例身份；发生替换或无法验证时，保留证据及限制，不能归属为已验证实例的日志。

日志源由根 ClientManager 托管，保存有界缓冲与本地 raw 文件。各请求拥有独立游标和匹配器，
晚加入者先补读已有内容，再跟随新内容，无需等待源读取结束才反馈命中。各自生成完整 raw 副本后，
根收尾回收源文件，交付与失败保留不依赖其它子命令的临时目录。

本地补读不占网络名额、不重复消耗字节预算；来源的 partial / unavailable 状态随快照保留，
不会因为另一个请求需要同一源而隐式重试。命令结果复用规则不参与日志源身份判断。

### 原始日志与时间线

采集产物分为三个用途：

- `raw/` 保留逐 Pod / Container 的原始日志，流式落盘，不把完整响应留在内存中。
- `timeline.jsonl` 保存筛选后的逻辑事件及 Service、Pod、Container、current / previous 来源。
- `service-logs.txt` 与 `report.html` 消费同一份时间线，分别用于文本阅读和交互排查，不重新解析 raw。

结束、失败或取消时刷出已取得的完整行。超时、字节预算或取消导致的不完整采集保留已获得内容，
不能当作完整覆盖。current 与 previous 分开记账，previous 不可用不使 current 读取失败，原因保留在采集记录中。
异常首行命中后保留常见 Python、JavaScript、Java 和 Go 堆栈续行，组成一个逻辑事件；
排序、计数和筛选都以事件为粒度，消息内换行仍用于多行展示。raw 与时间线不能互相替代。

`log-stats.json` 与报告记录下载字节数、复用路数、命中 Pod 数、首次命中耗时和采集 wall-clock。
耗时包括发现、排队与本地回放，不包括前置业务 ID 解析；下载量包含重试和已传输但超出终点的字节，
由源首次调用记账，复用方不重复计入。匹配数、首次命中和证据缺口仍归各自请求，零错误和零关联命中分别表达。

### 离线阅读

HTML 报告不依赖网络或外部静态资源。日志保存在页面内的结构化数据中，浏览器只挂载当前页，
避免整份日志一次性展开为大量 DOM。搜索、Service / Pod 与时间筛选、时间分布、命中跳转和容器上下文
只改变展示，不修改或取代时间线与 raw 证据。

## 终端摘要

`doctor log --service api --since 15m -f summary` 在终端输出采集状态、查询范围、各查询的匹配事件数、扫描 Pod 数和采集缺口；证据目录与 manifest 路径同时返回。摘要沿用公共长度限制，多 ID 查询超出部分仍完整保存在 `output.json`，原始日志、时间线和详细采集记录留在证据目录。

部分成功时，摘要保留已获得的匹配事件数和扫描 Pod 数，并分别展示对象关联缺口与日志采集缺口。
关联缺口沿用 Data 证据中的 Service、查询身份或数据来源及失败原因，表示依赖这些身份匹配的日志可能遗漏；
采集缺口表示部分来源或时段没有完整日志。两者都不抹掉已取得的日志，但限制完整时间线和排除性判断。
终端与证据目录中的摘要均解释这些限制；日志状态、数量和缺口优先于环境信息展示，使
`collect -f summary` 的有界子摘要也保留成功证据与失败原因。`partial` 状态与退出码保持原有语义。

匹配事件数不是错误数，零命中不代表服务正常；查询失败和部分采集会保留状态及原因。多个 ID 可能共享同一批 Pod 日志，因此摘要按查询展示，不累加成唯一日志总数。

`-f summary` 不接受 `-o`。需要完整机器可读输出时使用 `-f manifest`；需要指定持久化目录时使用 `-f manifest -o <目录>`。

## 代码归属

| 文件 | 职责 |
|---|---|
| [window.ts](../../src/collect/log/window.ts) | 时间窗口规则：显式参数、Data / Trace 贡献、padding 与默认策略 |
| [data-window.ts](../../src/collect/log/data-window.ts) | 从 Data Evidence 提取贡献与来源，保留无效贡献原因 |
| [trace-window.ts](../../src/collect/log/trace-window.ts) | 把本地完整 Trace span 范围转换为窗口贡献 |
| [workloads.ts](../../src/collect/log/workloads.ts) | 调用 Extension，选择并合并本次请求的 Workload |
| [fact/inspect.ts](../../src/collect/log/fact/inspect.ts) | 共享实例发现，按请求投影 Facts 与采集缺口 |
| [probe/service.ts](../../src/collect/log/probe/service.ts) | 调度日志读取，匹配内容并保留各来源证据 |

窗口贡献的适配归日志消费方；窗口规则不读取归档或输出日志。Workload 选择不解释 Pod Fact 的内部结构。
