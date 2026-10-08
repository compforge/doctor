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

Service 在 `extensions` 注册 `overview.summarize` 与可选的 `overview.sample`，通过 Extension 的
`namespace` 声明产品级或服务级作用域。Core 按 namespace 精确选择：默认使用
`plugin/<plugin-id>`，指定 Service 时使用 `plugin/<plugin-id>/service/<canonical-service-name>`。
Service alias 先解析为标准名。未声明所选概览或同一 namespace 内存在多个相同 kind 的实现时直接报错，
不隐式聚合、继承或借用其它 namespace 的操作；`--service` 与 `--services` 互斥。

namespace 表达统计归属，提供方 Service 决定操作的执行上下文。例如同一个 Service 可以同时提供
产品错误概览和自己的运行状况概览。summary 和 sample 分别保留各自的 Service 绑定与 access，
每次调用复用 Core 的授权、PluginContext、共享客户端及资源释放；namespace 不限制实现可以读取的数据。
需要 Service 上下文的 Overview 操作应由 Service 注册，产品级 namespace 同样适用。例：

```ts
const service = {
  ...apiService,
  extensions: [
    { ...requestErrorSummary, namespace: "plugin/example" },
    serviceHealthSummary, // 未声明 namespace，默认 plugin/example/service/<service-name>
  ],
};
```

Facet 契约由 SDK 的 `overview.ts` 定义。同一 Facet id 跨 provider 使用时须具有相同语义；Core 在
选择时合并 Facet，结果与样本以 namespace、Facet id、Entry key 定位。`diagnosis.json` 中 `providers`
保存 namespace、展示名和汇总结果，采样配额与样本也保留 namespace，数据访问 Service 不充当统计身份。

Core 在查询前冻结 `[from, to)`，summary 和 sample 使用同一窗口与 tenantId。Plugin 负责解释业务
时间字段，在 description 中说明统计口径，并在查询处限制结果数、声明截断。查询失败与“没有条目”是
不同状态；某个 provider 失败不会阻止其它 provider 展示结果。

确认后，Core 把每个选中 Entry 的正整数 `limit` 传给 Plugin。Plugin 返回不超过该配额的代表请求列表；
配额为 0 的 Entry 不调用 Plugin。Plugin 应返回最精确的 collect biz-id，并可提供源记录 Identity；数据已变化时
返回空列表。Core 校验返回数量，对 biz-id 去重并再次应用总上限后调用所选 Collect 子命令。采样失败保留
在对应 Entry，不以其他请求替代。概览及采样通过 PluginContext 访问，通过同一根 ClientManager 复用已初始化的客户端；每个 Entry 仍独立查询。采集阶段继续
使用各 collector 的访问策略与报告流水线。

Overview 引用批次 Collect 的产物；幂等复用的 Inspect/Tenant 保留同一 Artifact ID。Bundle 的根索引
统一提供 ID 到归档路径的映射，因此同名目录和多个 Collect manifest 均可保留，串行与并发采用同一规则。

## 耗时概览

`overview.cost` 是独立 Extension，可与 `overview.summarize` 在同一 namespace 共存，也可单独提供。
Core 使用相同的冻结窗口和租户条件调用它，以提供该 Extension 的原始 Service 准备 access；
两类查询独立记录成功或失败，一项失败不丢弃另一项的结果。未选择 Service 时仍只读取 Plugin namespace。

Provider 接收 `OverviewCostQuery`（`maxEntries` 约束统计条目，`maxRecords` 约束源记录，当前为 1000），
返回 `OverviewCostResult`：description 说明样本总体、时间字段、区间与百分位算法，entries 以稳定 key、
label、sampleCount、missingCount 和 durationMs（min/avg/p50/p95/max）描述耗时。
单位固定为毫秒；没有有效样本时省略 durationMs，不能用零替代未知值。缺失、不完整或无效区间计入
missingCount。Provider 在源头限制读取，并说明截断；Core 校验统计数据并限制展示条目。

终端和 HTML 显示耗时表，diagnosis.json 保留类型化统计。耗时条目当前仅供查看，不进入
`overview.sample` 或自动触发 Collect。具体数据位置与统计口径由 Plugin 持有。

## 消费方 HTTP Case 检查

Service 可以声明 `caseBindings`，表示它必须从自身 Workload 访问某个提供方产生的地址。
例如文件服务提供下载请求，消费方的容器必须能够访问该 URL；Doctor Host 的访问结果不能代替这一关系。
指定 Service 的 Overview 在概览查询后自动执行这些只读 GET/HEAD 检查，再进入可选的历史样本采集。
没有 summarize/cost 的 Service 也可以只提供 Case bindings。产品级概览保持自身 namespace 的统计范围，
不会隐式执行所有 Service 的检查。

Binding 以 `provider.namespace + provider.extension` 定位 Service 的 `case.http.provide` Extension，
以 `workload` 引用消费方已声明的 Workload。提供方使用自己的 PluginContext、access 与租户条件，
返回本次有效的 HTTP Case 列表；它只准备 URL、GET/HEAD 请求头与预期状态，不执行请求。
这个运行时接口独立于离线 `case.catalog`，签名 URL 不进入静态目录或配置。

Core 先解析消费方实例并确认 curl/exec 可用，再为每个实例获取新鲜 Cases，直接从消费方容器执行。
每个绑定最多检查 10 个 Running 实例，每个实例最多 10 个 Cases；提供方应在数据源处限制结果，
超限或提供方截断在报告中明确展示。实例未配置 container 且存在多个容器时报告缺口，不猜测业务容器。
请求沿用 HTTP Collect 的超时和响应容量预算，串行执行；代理与 TLS 使用目标容器 curl 的正常行为，
不绕过代理、不跳过证书验证、不回退到 Host/port-forward。重定向响应直接作为证据，不隐式跟随到另一目标。

Case 可给出有序备用 URL，主地址不满足预期时继续尝试，遇到成功停止；原地址失败始终保留，
备用成功不把绑定改判为通过。每次尝试记录提供方、binding、Case、Pod UID/container、请求 URL（查询值脱敏）、
时间、HTTP/transport 结果与 Finding，headers/body/error 附件随 Overview Bundle 交付。凭据头与已知签名值脱敏。
二进制文件保留受预算限制的响应内容；响应摘要对应下载流，文本附件可能经脱敏。

无法准备 Pod、无法取得 Case、空 Case 列表和请求失败分别记录阶段和原因；它们不是网络成功。
单个绑定失败不丢失其他绑定或统计结果，取消保留已完成的尝试。Case 时间是本次执行时间，
`--since` 的历史窗口只用于概览和后续采样。`doctor case` 的现有目录与发送入口保持独立。

消费方声明示例（提供方已在其 Service.extensions 注册 `file-downloads`）：

```ts
const worker = {
  ...workerService,
  caseBindings: [{
    id: "file-download", workload: "main",
    provider: { namespace: "plugin/example/service/files", extension: "file-downloads" },
  }],
};
```

提供方返回 `{ cases: [{ id, description, request: { url }, expect: { status: [200] } }] }`，
无可用样本时返回 `{ cases: [], reason: "当前租户没有可用文件" }`。
