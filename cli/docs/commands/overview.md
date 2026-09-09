# Overview

`doctor overview` 展示各 Service 值得注意的情况。Facet 是观察维度，例如请求错误；Entry 是该维度下
动态发现的条目，例如某个 error code。Entry 的 data 可以是数值或文字，只有 Plugin 明确声明可采样的
Entry 才进入后续采集。

## 使用

```bash
doctor overview
doctor overview --since 6h --services example-api --tenant-id <tenant-id>
doctor overview --since 1h --collect --facet errors
```

交互模式先选择近 10m、1h、6h、1d 或 3d，再展示所有 Service 的结果。用户可以直接结束，也可以选择
一个 Facet 并确认采集。只有一个可采集 Facet 时省略选择，仍需确认，默认不采集。非交互模式默认近 1h，
只有显式 `--collect` 才采集；多个可采集 Facet 时还需指定 `--facet`。`--facet` 本身不触发采集。

默认交付 HTML 和 Bundle；`--format html|bundle` 与 `--output` 控制交付形式。报告保留查询窗口、租户、
Service / Facet / Entry、数据、截断原因、采样来源和 collect biz-id；采集产物与概览一起交付。

## Provider 契约

Service 在 `capabilities.overview` 声明 `facets`、`summarize`、`sample` 和所需的 `access`。
具体类型见 SDK 的 `overview.ts`。同一个 Facet id 跨 Service 使用时必须具有相同语义；Core 在选择时
合并 Facet，结果与样本始终以 Service、Facet id、Entry key 定位。

Core 在查询前冻结 `[from, to)`，summary 和 sample 使用同一窗口与 tenantId。Plugin 负责解释业务
时间字段，在 description 中说明统计口径，并在查询处限制结果数、声明截断。查询失败与“没有条目”是
不同状态；某个 Service 失败不会阻止其它 Service 展示结果。

确认后，每个可采样 Entry 查询一个代表请求。Plugin 应返回最精确的 collect biz-id，并可提供源记录
Identity；数据已变化时返回无样本。Core 对 biz-id 去重后复用 data、trace、log collect。采样失败保留
在对应 Entry，不以其他请求替代。概览阶段使用既有 PluginContext 访问和资源回收机制，采集阶段继续
使用各 collector 的访问策略与报告流水线。
