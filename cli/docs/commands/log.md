# Log 采集

Doctor 使用现有 Kubernetes Service、Pod 和 pods/log 访问权限采集服务日志。不带业务 ID 时采集时间窗口内的日志，不调用 trace resolver 或准备其业务依赖；带 ID 时搜索关联 trace 日志，解析失败不会降级成无过滤采集。某个 Pod 命中只触发即时反馈，不减少其他 Pod 的覆盖；current 与可用的 previous 容器日志都保留来源。

```bash
doctor log                         # 默认 Service / 时间窗口；交互时可选择 Service
doctor log --services api -n prod --since 15m
doctor log --services api --since-time '2026-09-16T15:00:00+08:00' --until-time '2026-09-16T15:15:00+08:00'
doctor log <biz-id> --since 15m      # 保留 trace 关联模式
```

`--services` 和时间起点都可省略：非交互使用 Plugin 的默认日志 Service，交互沿用 Service 多选；无 ID 默认回看 6 小时。`--errors-only` 和 `--pattern` 在两种模式下均可用。

## 时间范围与读取

显式 `--since-time` 优先于 `--since`；未指定时沿用 UUIDv7 起点推导及默认回看窗口。可靠的日志终点可通过 `--until-time`（RFC3339）传入，终点包含在范围内。无 ID 且省略终点时固定为命令开始时刻，不持续跟随；该快照边界不是业务请求结束时间。带 ID 时不从 ID 或采样 Trace 猜测请求结束时间。

Kubernetes Log API 只接受时间起点。Doctor 按容器运行时日志时间戳读取，遇到第一条超过终点的记录后关闭流，并将该请求范围记为正常完成。时间范围依赖容器日志按运行时时间排列；终点外的记录不进入结果。范围内的异常首行和堆栈续行仍组成一个逻辑日志事件。

## 流式反馈与证据

共享并发池限制跨 Service 的在途请求。每条流独立匹配 trace ID（无 ID 时接收窗口内日志），首次命中立即报告来源；错误和内容筛选不影响定位。报告最终按时间排序，避免为了全局排序而等待无命中的 Pod 才反馈结果。

原始日志以有界缓冲批量写盘，结束、失败或取消时刷出已取得的完整行。超时、字节预算和取消仍保留部分证据，不当作完整覆盖。

`log-stats.json` 与报告记录下载字节数、复用路数、trace 命中 Pod 数、首次命中耗时和采集 wall-clock。
时间从日志采集开始计，包含 Pod 发现、排队与本地回放，不包含前置业务 ID 解析；下载量包含重试和已传输
但超出终点的字节，由实际发起源读取的调用记账，复用方不重复计入。无错误日志与无 trace 命中分别表达。

同一根执行中，多个 biz-id 可复用同一 Pod/Container 实例、同一明确时间范围的 raw 快照，并独立筛选和
保留证据；没有可靠实例身份或使用相对时间窗口时独立读取。复用沿用源的部分采集状态，不声称扩大了覆盖。
全 Pod 覆盖、根并发与字节预算、资源生命周期见 [Log 采集设计](log-diagnosis.md)。
