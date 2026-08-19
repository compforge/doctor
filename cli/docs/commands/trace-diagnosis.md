# Trace 采集设计

## 理念 / 概念

`doctor trace` 从 SearchEngine 下载 trace 的完整 span 证据，并在 Doctor Host 本地生成可交互
HTML。命令接收一个或多个业务 ID，先调用 Plugin `traceId` capability；每个 ID 可解析为一条或多条规范
trace_id。领域层负责确认、计数、
分页下载和渲染，`infra/search` 负责 OpenSearch 协议，`collect/shared/opensearch-access` 负责 Trace/VDB 共用的
连接确认和生命周期，`infra/k8s` 负责 Service 解析和临时网络通道。

默认同时交付自包含 HTML 和完整 Bundle。HTML 提供逻辑节点树、火焰图、节点摘要和物理 span 溯源；
Bundle 同时包含根 `report.html`、完整 `spans.jsonl`、摘要和 Evidence Worksheet，摘要不能替代原始
span。显式 `--format html` 或 `--format bundle` 时只交付所选格式。

## 流程

1. app 在访问环境前确认当前 Plugin 至少声明一个 `service.traceId` provider；Core 注入当前选择的
   Kubernetes 环境与 provider Service 身份，Plugin 自行定位运行态和数据源，并为每个 positional ID 或
   重复 `--biz-id` 返回一条或多条规范 trace_id、解析语义及可选来源 ID。provider Service
   声明 capability 依赖时，Core 在调用前将其解析为受限运行时 handle。
2. 配置确认解析 index、鉴权和访问方式；`--endpoint` 表示 Doctor Host 可直连的 OpenSearch 地址。
   未提供时优先使用 `PluginDefinition.trace.source.store` 引用的业务 Service Store，再按 Service Catalog
   顺序尝试其余 OpenSearch VDB Store；每个 Store 都独立解析 endpoint、backend Service 和 namespace。
3. 网络准备按确认结果建立 Service port-forward、探测可用协议并初始化 SearchEngine，统一拥有 client 和 forward 生命周期；
   ID 解析与 span 下载命中同一 Store 时复用同一连接。
4. Probe 只按 Plugin 返回的规范 trace_id 查询 span 总数，不再用任意 span tag 猜测业务 ID 关系。
5. trace 存在时用稳定排序和 `search_after` 分页下载全量 `_source`，逐页追加到 `spans.jsonl` 并累计统计。
6. Render 使用 TypeScript trace-harness 将物理 span 归一化并聚合为逻辑节点树，再结合
   `PluginDefinition.trace.analysis` 显式提供的 specs / features / detectors / facets 生成交互式 HTML。
7. Evidence Worksheet 分别记录 ID 确认、计数、下载和 HTML 渲染状态；批量 HTML 按 biz-id 分顶层
   tab，同一 biz-id 的多条 trace 再按来源 message/trace 分子 tab。各组只共享交付壳，不混合 span、
   Finding 或 Coverage；bundle 同样按 biz-id/trace 目录隔离。
8. 交付结束后关闭 SearchEngine、回收 forward；下载中断时保留已经落盘的 span 和失败上下文。

## 关键设计

### Service 确认先于网络准备

Service 发现回答“本轮目标是谁”，属于配置确认；port-forward 回答“如何从本机访问”，属于网络准备。
两者分开后，Probe 不需要理解 Kubernetes，也不会在查询过程中隐式创建新通道。

### 计数和下载是两份证据

预先 count 既验证目标 trace 存在，也给全量下载提供完整性基准。下载条数与 count 不一致时仍保留
数据，但本次 Evidence 标为不完整；退出码表达证据完整度，不表达 trace 中是否存在错误 span。

### SearchEngine 保持协议通用

输入 ID 的业务解析策略属于 Plugin `traceId` capability；Jaeger 字段和摘要统计属于 Trace domain。OpenSearch client、鉴权、请求
超时和 search API 映射属于 infra。领域代码依赖 SearchEngine 契约，不把 Kubernetes 或官方 client
对象穿透到 Probe 和 Render。

### 业务语义由 Plugin 显式贡献

trace-harness 只提供与 Python 版本一致的 span 归一化、逻辑节点融合、诊断和 HTML 渲染能力，不认识
具体 Plugin。Plugin 通过 `trace.analysis` 提供 trace-harness 原生的 scoped contributions，用于节点分类、
派生特征、业务判读和展示意图；Core 为每次 trace 采集创建独立 TraceHarness，因此模块加载顺序不会改变
分析结果，业务规则也不会进入通用采集层。analysis 只消费 Trace IR/Facts，不读取 Plugin config、infra
或外部资源。
