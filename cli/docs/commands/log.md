# Log 采集

Doctor 从 Plugin Service 的 Workload 声明定位日志实例，再通过共享 Client 读取 Pod 日志；逻辑 Service 名不作为 Kubernetes 资源名。不带业务 ID 时采集时间窗口内的日志，不调用 trace resolver 或准备其业务依赖；带 ID 时搜索关联 trace 及 Plugin 声明的对象日志，全部解析失败不会降级成无过滤采集。某个 Pod 命中只触发即时反馈，不减少其他 Pod 的覆盖；current 与可用的 previous 容器日志都保留来源。

```bash
doctor log                         # 默认 Service / 时间窗口；交互时可选择 Service
doctor log --services api -n prod --since 15m
doctor log --services api --since-time '2026-09-16T15:00:00+08:00' --until-time '2026-09-16T15:15:00+08:00'
doctor log <biz-id> --since 15m      # trace 与已解析对象关联
```

`--services` 和时间起点都可省略：非交互使用 Plugin 的默认日志 Service，交互沿用 Service 多选；无 ID 默认回看 6 小时。`--errors-only` 和 `--pattern` 在两种模式下均可用。

## Workload 与采集范围

Service 可以声明多个 Workload，位置可以是 Kubernetes Service、labels 或具体资源。Core 解析其 Running Pod，
并按声明的 container 采集；未限定 container 时采集 Pod 的 application containers。交互候选来自 Plugin Catalog，
不要求逻辑名称与集群 Service 同名。没有 Workload 声明、没有实例或定位失败都形成明确的证据缺口，
不回退为同名资源查询，也不抹掉其它 Workload 已取得的日志。

每次命令仍限定一个 namespace。Workload 声明其它 namespace 时提示用 `--namespace` 单独采集，
不会静默切换目标。Manifest 的 Inspect Facts 保留 Service → WorkloadInstance 关联和定位缺口，
包括环境、namespace、Pod UID 与 container；重叠声明保留各自来源，读取计划按实际容器去重。

## 时间范围与读取

显式 `--since-time` 优先于 `--since`；未指定时沿用 UUIDv7 起点推导及默认回看窗口。可靠的日志终点可通过 `--until-time`（RFC3339）传入，终点包含在范围内。无 ID 且省略终点时固定为命令开始时刻，不持续跟随；该快照边界不是业务请求结束时间。带 ID 时不从 ID 或采样 Trace 猜测请求结束时间。

Kubernetes Log API 只接受时间起点。Doctor 按容器运行时日志时间戳读取，遇到第一条超过终点的记录后关闭流，并将该请求范围记为正常完成。时间范围依赖容器日志按运行时时间排列；终点外的记录不进入结果。范围内的异常首行和堆栈续行仍组成一个逻辑日志事件。

## 流式反馈与证据

共享并发池限制跨 Service 的在途请求。每条流独立匹配 trace 或声明的对象身份（无 ID 时接收窗口内日志），首次命中立即报告来源；错误和内容筛选不影响定位。报告最终按时间排序，避免为了全局排序而等待无命中的 Pod 才反馈结果。

原始日志以有界缓冲批量写盘，结束、失败或取消时刷出已取得的完整行。超时、字节预算和取消仍保留部分证据，不当作完整覆盖。

`log-stats.json` 与报告记录下载字节数、复用路数、关联命中 Pod 数、首次命中耗时和采集 wall-clock。
时间从日志采集开始计，包含 Pod 发现、排队与本地回放，不包含前置业务 ID 解析；下载量包含重试和已传输
但超出终点的字节，由实际发起源读取的调用记账，复用方不重复计入。无错误日志与无关联命中分别表达。

同一根执行中，多个 biz-id 可复用同一 Pod/Container 实例、同一明确时间范围的 raw 快照，并独立筛选和
保留证据；没有可靠实例身份或使用相对时间窗口时独立读取。复用沿用源的部分采集状态，不声称扩大了覆盖。
全 Pod 覆盖、根并发与字节预算、资源生命周期见 [Log 采集设计](log-diagnosis.md)。

## 终端摘要

`doctor log --services api --since 15m -f summary` 在终端输出采集状态、查询范围、各查询的匹配事件数、扫描 Pod 数和采集缺口；证据目录与 manifest 路径同时返回。摘要沿用公共长度限制，多 ID 查询超出部分仍完整保存在 `output.json`，原始日志、时间线和详细采集记录留在证据目录。

匹配事件数不是错误数，零命中不代表服务正常；查询失败和部分采集会保留状态及原因。多个 ID 可能共享同一批 Pod 日志，因此摘要按查询展示，不累加成唯一日志总数。

`-f summary` 不接受 `-o`。需要完整机器可读输出时使用 `-f manifest`；需要指定持久化目录时使用 `-f manifest -o <目录>`。

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
