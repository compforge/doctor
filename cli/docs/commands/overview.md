# Overview

`doctor overview` 默认展示当前 Plugin 的产品级概览；`--service` 选择单个 Service，`--services` 比较多个 Service。Facet 是观察维度，例如请求错误；Entry 是该维度下
动态发现的条目，例如某个 error code。Entry 的 data 可以是数值或文字，只有 Plugin 明确声明可采样的
Entry 才进入后续采集。

## 使用

```bash
doctor overview
doctor overview --since 6h --service example-api --tenant-id <tenant-id>
doctor overview --since 6h --services example-api,example-worker
doctor overview --since 1h --collect --facet errors --sample-count 5
```

交互模式先选择近 10m、1h、6h、1d 或 3d，再展示所选范围的结果。用户可以直接结束，也可以选择
一个 Facet 并确认采集。只有一个可采集 Facet 时省略选择，仍需确认，默认不采集。非交互模式默认近 1h，
只有显式 `--collect` 才采集；多个可采集 Facet 时还需指定 `--facet`。`--facet` 本身不触发采集。

选定 Facet 后，交互模式在可采样 Entry 多于一个时显示多选列表；只有一个时直接选中，不额外询问。
列表默认预选采样预算范围内的前几项，允许增减后确认；按 Esc 取消后不采样、不 collect。非交互模式选中
全部可采样 Entry。默认顺序沿用大盘中的 provider / Entry 顺序，不按 data 重新排序，因为 data 也可以是文字。

`--sample-count` 覆盖 profile 的 `overview.sample_count`，未配置时为 5，必须是正整数。它控制代表请求的全局硬上限，
不是 Entry 选择数。Core 在所选 Entry 间按大盘顺序尽量平均分配：每项先分配
`floor(sample-count / Entry 数)`，余数再从前往后每项加一。例如预算 5 且选择 1、2、3 项时，配额分别为
`[5]`、`[3,2]`、`[2,2,1]`。选择 6 项时分配为 `[1,1,1,1,1,0]`，Core 为每个配额为 0 的 Entry 分别输出
黄色“配额为 0（未采集）”提示，保留选择与配额记录并继续执行。样本缺失、去重或失败会使实际数量少于预算，
不跨 Entry 补位：

```yaml
profiles:
  test:
    readonly: true
    overview:
      sample_count: 5
```

采样并去重后，Core 复用 Collect 的命令选择：交互模式选择一次，非交互默认全部；`--include` 可显式
指定 inspect、tenant、data、trace、log、metric 的子集（例如 `--include inspect,tenant,data,trace,log`）。
Core 将整批 biz-id 交给一次 Collect，各子命令接收完整列表。Inspect、Tenant、Metric 在该批次中各执行一次；
Data 共用访问准备与 Identity 查询，Log 共用目标准备与原始日志源，每个输入仍独立诊断和保留证据。
`--collect-concurrency` 覆盖 profile 的 `overview.collect_concurrency`，控制批次内需要逐 ID 执行的日志工作，
默认 2。失败请求不阻止其它请求完成；取消后不启动排队工作，已经取得的证据仍统一交付。
Overview 把冻结的查询起止时间传给 Collect，日志采集沿用 Log 的包含终点时间戳语义。

日志网络读取使用独立的全局预算：整棵命令树共享 `log.concurrency` 个 Pod/Container 读取名额，默认 4，
并共享总字节预算。current、previous 和重试均受约束；本地快照回放不重复消耗网络预算。
例如下列配置最多同时处理两个 ID 的日志工作，而实际 Pod 日志读取最多八路：

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
provider namespace / Facet / Entry、数据、截断原因、采样来源和 collect biz-id；采集产物与概览一起交付。

## Provider 契约

Plugin 顶层的 `extensions` 注册产品级 `overview.summarize` 与可选的 `overview.sample`；
Service 的 `extensions` 注册相同 kind 的服务级实现。Core 按 namespace 精确选择：默认使用
`plugin/<plugin-id>`，指定 Service 时使用 `plugin/<plugin-id>/service/<canonical-service-name>`。
Service alias 先解析为标准名。未声明所选概览或同一 namespace 内存在多个相同 kind 的实现时直接报错，
不隐式聚合、继承或借用其它 namespace 的操作；`--service` 与 `--services` 互斥。

namespace 表达统计归属，数据访问目标由 `targetService` 指向 Catalog 中的 Service。产品级操作必须
显式声明它；Service 级操作默认使用所属 Service。summary 和 sample 分别声明目标与 access，
每次调用复用 Core 的授权、PluginContext、共享客户端及资源释放。例：

```ts
const productOverview = {
  ...requestErrorSummary,
  targetService: "example-api",
};
const plugin = { ...definition, extensions: [productOverview] };
```

Facet 契约由 SDK 的 `overview.ts` 定义。同一 Facet id 跨 provider 使用时须具有相同语义；Core 在
选择时合并 Facet，结果与样本以 namespace、Facet id、Entry key 定位。`diagnosis.json` 中 `providers`
保存 namespace、展示名和汇总结果，采样配额与样本也保留 namespace，数据访问 Service 不充当统计身份。

Core 在查询前冻结 `[from, to)`，summary 和 sample 使用同一窗口与 tenantId。Plugin 负责解释业务
时间字段，在 description 中说明统计口径，并在查询处限制结果数、声明截断。查询失败与“没有条目”是
不同状态；某个 provider 失败不会阻止其它 Service 展示结果。

确认后，Core 把每个选中 Entry 的正整数 `limit` 传给 Plugin。Plugin 返回不超过该配额的代表请求列表；
配额为 0 的 Entry 不调用 Plugin。Plugin 应返回最精确的 collect biz-id，并可提供源记录 Identity；数据已变化时
返回空列表。Core 校验返回数量，对 biz-id 去重并再次应用总上限后调用所选 Collect 子命令。采样失败保留
在对应 Entry，不以其他请求替代。概览及采样通过 PluginContext 访问，通过同一根 ClientManager 复用已初始化的客户端；每个 Entry 仍独立查询。采集阶段继续
使用各 collector 的访问策略与报告流水线。

Overview 引用批次 Collect 的产物；幂等复用的 Inspect/Tenant 保留同一 Artifact ID。Bundle 的根索引
统一提供 ID 到归档路径的映射，因此同名目录和多个 Collect manifest 均可保留，串行与并发采用同一规则。
