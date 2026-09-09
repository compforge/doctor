# Overview

`doctor overview` 展示各 Service 值得注意的情况。Facet 是观察维度，例如请求错误；Entry 是该维度下
动态发现的条目，例如某个 error code。Entry 的 data 可以是数值或文字，只有 Plugin 明确声明可采样的
Entry 才进入后续采集。

## 使用

```bash
doctor overview
doctor overview --since 6h --services example-api --tenant-id <tenant-id>
doctor overview --since 1h --collect --facet errors --sample-count 5
```

交互模式先选择近 10m、1h、6h、1d 或 3d，再展示所有 Service 的结果。用户可以直接结束，也可以选择
一个 Facet 并确认采集。只有一个可采集 Facet 时省略选择，仍需确认，默认不采集。非交互模式默认近 1h，
只有显式 `--collect` 才采集；多个可采集 Facet 时还需指定 `--facet`。`--facet` 本身不触发采集。

选定 Facet 后，默认采样前 5 个可采样 Entry，这个数量跨 Service 合计。大盘展示不受影响；默认顺序
沿用大盘中的 Service / Entry 顺序，不按数值重新排序，因为 Entry data 也可以是文字。超过默认数量时，
交互模式显示 Entry 多选列表，预选前 5 项，允许增减后确认采集；按 Esc 取消后不采样、不 collect。
非交互模式只采前 5 项，每项至多一个代表请求；样本缺失或失败不自动补选其他 Entry。

`--sample-count` 覆盖 profile 的 `overview.sample_count`，未配置时为 5，必须是正整数。它控制默认选择
数量，交互模式的显式选择可以超过该数量：

```yaml
profiles:
  test:
    readonly: true
    overview:
      sample_count: 5
```

采样并去重后，Core 复用 Collect 的命令选择：交互模式选择一次，非交互默认全部；`--include` 可显式
指定 inspect、tenant、data、trace、log、metric 的子集（例如 `--include inspect,tenant,data,trace,log`）。
Core 按 biz-id 并发调用 Collect，默认同时处理 2 个请求，每个请求内部按所选命令顺序执行。
Inspect、Tenant 的 Input 提供幂等 key，相同环境/检查范围或相同租户/采集参数只执行一次；并发调用等待
同一次执行，后续调用复用原状态和产物，最终报告保留 Inspect、Tenant 页签。范围改变则另行执行。
`--collect-concurrency` 覆盖 profile 的 `overview.collect_concurrency`。失败请求不阻止其它
请求完成；取消后不启动排队任务，已启动任务响应同一取消信号，已取得的证据仍统一交付。报告按输入顺序
合并，终端选择与确认串行执行，后台输出在交互完成后恢复。

日志使用独立的全局预算：同一次 Doctor 运行的整个 CommandContext 命令树共享 `log.concurrency` 个
Pod/Container 日志读取名额，默认 4。current、previous 和重试都不能绕过这个池；每项请求从开始读取到
流关闭才归还名额。提高 Collect 并发数不会乘大日志并发数，字节预算仍按原来的单次 Log 采集计算。
例如下列配置最多并发两个 Collect，而所有 Collect 合计最多并发读取八路 Pod 日志：

```yaml
profiles:
  test:
    readonly: true
    overview:
      sample_count: 5
      collect_concurrency: 2
    log:
      concurrency: 8
```

默认交付 HTML 和 Bundle；`--format html|bundle` 与 `--output` 控制交付形式。报告保留查询窗口、租户、
Service / Facet / Entry、数据、截断原因、采样来源和 collect biz-id；采集产物与概览一起交付。

## Provider 契约

Service 在 `capabilities.overview` 声明 `facets`、`summarize`、`sample` 和所需的 `access`。
具体类型见 SDK 的 `overview.ts`。同一个 Facet id 跨 Service 使用时必须具有相同语义；Core 在选择时
合并 Facet，结果与样本始终以 Service、Facet id、Entry key 定位。

Core 在查询前冻结 `[from, to)`，summary 和 sample 使用同一窗口与 tenantId。Plugin 负责解释业务
时间字段，在 description 中说明统计口径，并在查询处限制结果数、声明截断。查询失败与“没有条目”是
不同状态；某个 Service 失败不会阻止其它 Service 展示结果。

确认后，仅对选中的 Entry 各查询一个代表请求。Plugin 应返回最精确的 collect biz-id，并可提供源记录
Identity；数据已变化时返回无样本。Core 对 biz-id 去重后调用所选 Collect 子命令。采样失败保留
在对应 Entry，不以其他请求替代。概览及采样通过 PluginContext 访问，通过同一根 ClientManager 复用已初始化的客户端；每个 Entry 仍独立查询。采集阶段继续
使用各 collector 的访问策略与报告流水线。
