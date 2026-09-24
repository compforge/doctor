# Trace 采集设计

## 理念 / 概念

`doctor trace` 从 SearchEngine 下载 trace 或指定 span 的证据，在 Doctor Host 保存机器可读节点树，
并支持纯离线下钻和可交互 HTML。在线命令统一接收业务 ID 或 trace ID，由 Plugin `trace.resolve`
将 ID 解析为规范 trace_id；时间范围由 `trace.range` 解析。Core 冻结目标列表后负责确认、计数、
分页下载和渲染，`infra/search` 负责 OpenSearch 协议，`collect/shared/opensearch-access` 负责 Trace/VDB 共用的
连接确认和生命周期，`infra/k8s` 负责 Service 解析和临时网络通道。

默认同时交付自包含 HTML 和完整 Bundle。HTML 提供逻辑节点树、火焰图、节点摘要和物理 span 溯源；
Bundle 同时包含根 `report.html`、完整 `spans.jsonl`、摘要和 Evidence Worksheet，摘要不能替代原始
span。显式 `--format html`、`--format bundle` 或 `--format manifest` 时只交付所选格式。

```bash
doctor trace <biz_id> --format manifest
doctor trace --biz-id <trace_id> --biz-id <biz_id> --format manifest
doctor trace --since 1h --limit 50 --concurrency 2 --format manifest
doctor trace --since-time 2026-09-23T08:00:00+08:00 --until-time 2026-09-23T09:00:00+08:00
doctor trace --trace-file ./trace.json --format html
doctor trace <biz_id> --span <span_id> --format manifest
doctor trace --from <manifest路径> --node <node_id> --format manifest
doctor trace --from <manifest路径> --span <span_id> --format manifest
doctor trace --from <manifest路径> --format html
doctor trace --from <manifest路径> --format bundle
```

Manifest 输出一份 JSON，`bundle_root` 是命令退出后仍保留的临时目录（也可用 `--output` 指定新目录），
`artifacts[].files` 索引 tree、analysis、findings、spans 以及下钻的 selection 文件。
这些路径相对于根 Bundle；Artifact 自己的 `manifest.json` 中 `files` 则相对于该 Artifact。

## 流程

1. app 按输入模式确认所需的 Plugin Extension：ID 使用 `trace.resolve`，时间范围使用
   `trace.range`。Core 注入当前选择的 Kubernetes 环境与 provider Service 身份，Plugin 自行定位
   运行态和数据源，并为每个 positional ID 或重复 `--biz-id` 返回一条或多条规范 trace_id、
   解析语义及可选来源 ID。输入 ID 不预设类型；provider 判断后返回 `resolvedAs`，可为 `trace_id`。不能仅按 32 位
   十六进制形状判断，因为业务 ID 也可能采用相同形式。provider Service
   声明 capability 依赖时，Core 在调用前将其解析为受限运行时 handle。
   时间范围的 `--limit` 传给 Plugin，Plugin 须显式返回截断信息；实现可先限量候选记录，
   再对其 trace ID 去重，因此最终 trace 数可能小于 limit。
2. 配置确认解析 index、鉴权和访问方式；`--endpoint` 表示 Doctor Host 可直连的 OpenSearch 地址。
   未提供时优先使用 `PluginDefinition.trace.source.dataSource` 引用的业务 Service Store，再按 Service Catalog
   顺序尝试其余 OpenSearch VDB Store；每个 Store 都独立解析 endpoint、backend Service 和 namespace。
3. 网络准备按确认结果建立 Service port-forward、探测可用协议并初始化 SearchEngine，统一拥有 client 和 forward 生命周期；
   ID 解析与 span 下载命中同一 Store 时复用同一连接。
4. Probe 只按已确认的规范 trace_id 查询 span 总数，不用任意 span tag 猜测业务 ID 关系。
   `--span` 同时限定 traceID 和 spanID，count 与下载使用同一过滤条件；业务 ID 解析出多条不同 trace 时
   报歧义，要求用明确 trace ID 重试，不先下载整条 trace 再过滤。
5. Core 对 trace 目标施加有界并发；同一 trace 用稳定排序和 `search_after` 顺序下载 `_source`，
   逐页追加到独立的 `spans.jsonl` 并累计统计。根 manifest 在下载前保存目标、来源、时间窗和截断情况。
6. 采集后使用 TypeScript trace-harness 的 `JaegerFileSource` 读取已落盘的 `spans.jsonl`，通过
   TraceSession 为当前 trace 获取 lease、归一化并组装逻辑节点树。异步分析按 Plugin 声明的字段和 fact
   依赖准备本地证据，再执行 transforms / measurers / detectors；渲染前以 `prepareView({ full: true })`
   补齐展示与原始 span 详情，将同一次分析的 Node、归一化 span、Findings 与 Measurements 保存为 JSON。
   单 span 或不完整采集不运行全 trace Detector / Measurement，避免将未采集误判为业务缺失。
   成功或失败都会释放 lease、关闭 session，清理临时索引和缓存；原始采集产物继续保留。
7. Evidence Worksheet 分别记录 ID 确认、计数、下载和分析投影状态；Render 消费已保存的分析，不重复
   执行 Detector。批量 HTML 按 biz-id 分顶层
   tab，同一 biz-id 的多条 trace 再按来源 message/trace 分子 tab。各组只共享交付壳，不混合 span、
   Finding 或 Coverage；bundle 同样按 biz-id/trace 目录隔离。
8. 根入口释放 SearchEngine / forward 并按 format 交付；下载中断时保留已经落盘的 span 和失败上下文，
   尽力为已下载部分建立本地索引，不能把索引成功当作下载完整。

`--trace-file` 是另一条本地入口：trace-harness 解析一条 Jaeger UI JSON、JSON 数组或 JSONL trace，
Doctor 保存原文件和展开后的 `spans.jsonl`，从投影步骤进入同一套 snapshot、HTML 和 Bundle 交付。
它不加载 Plugin，也不访问 Kubernetes 或 OpenSearch。一个文件含多条 trace 时需先拆分，以免静默丢失。
`--from` 则读取已有 Doctor manifest 和冻结分析结果，只做离线下钻或重渲染，不重新运行 Detector。

## 离线证据与下钻

`--from` 接受根 Bundle manifest 或某条 trace 的 Artifact manifest。它不加载 Plugin、不准备 Kubernetes，
也不访问 OpenSearch；不能与业务 ID、在线查询参数同时使用，`--node` 只用于离线，且不能与 `--span` 同用。
Bundle 搬迁后以 manifest 实际所在目录解析路径，拒绝越界路径和符号链接。

- `tree.json`：版本化的轻量索引，包含 `roots[]`、父子节点 ID、类型、服务、时间和 node → span 映射。
- `analysis.json`：采集时冻结的节点事实、完整归一化 span 属性、Measurements 与 Agent Run 投影。
  不保存可执行 Plugin 代码或 harness 临时缓存路径。
- `findings.json`：确定性诊断结果；不是 AI 的根因结论。
- `spans.jsonl`：下载的原始 Jaeger `_source`，不经终端 raw 文本截断。
- `selection.json`：指定 node 及其直接拥有的 spans，或指定 span 的属性与原始记录；不隐式展开子树。

Node 不等于 span，一个 node 可以拥有多个 spans。下钻以保存的映射为准，不因当前 Plugin 升级而重算
node ID。一个 ID 在多个 Artifact 中命中时，要求改用具体 Artifact manifest，不静默取第一条。
找不到时只报告“本地证据未包含”，不会补采；缺失关联 raw span 也会报错。

`collection.scope` 区分整条 trace 与单 span，`collection.complete` 只说明该查询范围是否下载完整，
不能把完整的单 span 查询当作完整 trace。源步骤失败、截断和采集来源随证据保留。
离线操作在新目录复制证据、添加选择结果，既不修改输入目录，也不在交付清理时删除输入。

离线 HTML 使用保存的节点、事实、Findings 和 Measurements 与 harness 通用 viewer，不重新加载业务
Plugin 的自定义展示函数；在线 HTML 仍可使用本轮 Plugin 的 facets。HTML 与 Bundle 均复用根交付流程。
旧证据缺少分析索引时不能 node/span 下钻；原始文件可归档保留，但不会静默按新 Plugin 重新解释。

## 关键设计

### Service 确认先于网络准备

Service 发现回答“本轮目标是谁”，属于配置确认；port-forward 回答“如何从本机访问”，属于网络准备。
两者分开后，Probe 不需要理解 Kubernetes，也不会在查询过程中隐式创建新通道。

### 计数和下载是两份证据

预先 count 既验证目标 trace 存在，也给下载提供完整性基准。下载条数与 count 不一致时仍保留
数据，但本次 Evidence 标为不完整；退出码表达证据完整度，不表达 trace 中是否存在错误 span。
实时 `search_after` 不固定索引快照，下载期间索引变化可能影响跨页结果；Evidence 保存当前实时采集语义。

### SearchEngine 保持协议通用

输入 ID 的业务解析策略属于 Plugin `traceId` capability；Jaeger 字段和摘要统计属于 Trace domain。OpenSearch client、鉴权、请求
超时和 search API 映射属于 infra。领域代码依赖 SearchEngine 契约，不把 Kubernetes 或官方 client
对象穿透到 Probe 和 Render。

### 业务语义由 Plugin 显式贡献

trace-harness 只提供与 Python 版本一致的 span 归一化、逻辑节点融合、诊断和 HTML 渲染能力，不认识
具体 Plugin。Plugin 通过 `trace.analysis` 提供 trace-harness 原生的 scoped contributions，用于节点分类、
fact 转换、Measurement、业务判读和展示意图；Core 为每次 trace 采集创建独立 TraceHarness，因此模块加载顺序不会改变
分析结果，业务规则也不会进入通用采集层。Plugin 用 `structure_fields` 声明分类和融合所需字段，
用 `detail_fields` / `detail_facts`、FactProducer 与 `requires` 声明分析和展示依赖；异步 Detector
通过 `analysis.fact()` 等入口等待事实就绪。analysis 只消费 Trace IR/Facts，依赖读取由 Session
从本地证据完成，不读取 Plugin config、infra 或外部资源。

每个 Session 只处理一条 trace，`activeTraces` 设为 1，其余加载预算沿用 harness 默认值
（单 trace 64 MiB、缓存 128 MiB）。超出预算时分析投影记录失败，完整 `spans.jsonl` 仍保留在
Evidence 中；不通过截断 span 生成看似完整的诊断结果。

### 摘要中的时间与重复调用

摘要按 Service / Operation 汇总已采集 span 的数量及首末时间，帮助识别尾部的重复调用。
统计使用 span 开始时间定位调用分布，另列最晚结束时间以保留长调用的影响；按数量展示有限分组，
完整记录保留在原始 spans 中。重复调用是否属于重试、轮询或正常业务行为，需要结合调用内容判断。

Trace 覆盖范围从最早 span 开始到最晚 span 结束，可能包含问答结束后的后台活动。
问答耗时应根据业务请求的起止或终态证据确认，不能用 trace 跨度替代。

### 累计调用统计解释慢在哪里

选择节点后，Measurements 展示从请求开始到该节点结束的调用次数、耗时总和与覆盖时间，按 kind 区分
HTTP、model 和 tool。窗口包含尚未结束调用已发生的部分；它不是节点内部子树统计。调用可能并行或嵌套，
耗时总和可以超过 wall-clock，覆盖时间也不能直接当作对用户等待的因果贡献。
