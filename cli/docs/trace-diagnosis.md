# Trace 采集设计

## 理念 / 概念

`doctor trace` 从 SearchEngine 下载一条 trace 的完整 span 证据，并在 Doctor Host 本地生成可交互
HTML。命令接收业务 ID，先复用 Plugin data capability 解析为 trace_id；领域层负责确认、计数、分页下载和
渲染，`infra/search` 负责 OpenSearch 协议，`collect/shared/opensearch-access` 负责 Trace/VDB 共用的
连接确认和生命周期，`infra/k8s` 负责 Service 解析和临时网络通道。

默认交付物是自包含 HTML，提供逻辑节点树、火焰图、节点摘要和物理 span 溯源。需要保留采集证据时
可选择 bundle；bundle 同时包含 HTML、完整 `spans.jsonl`、摘要和 Evidence Worksheet，摘要不能替代
原始 span。

## 流程

1. Plugin data capability 从 `--biz-id` 解析出规范 trace_id。
2. 配置确认解析 index、鉴权和访问方式；`--endpoint` 表示 Doctor Host 可直连的 OpenSearch 地址。
   未提供时复用 Plugin 声明的业务 Service Store 运行时配置，并从 endpoint 解析 backend Service 和
   namespace；配置不可用时才带 warning 跨 namespace 自动发现。
3. 网络准备按确认结果建立 Service port-forward、探测可用协议并初始化 SearchEngine，统一拥有 client 和 forward 生命周期。
4. Probe 先确认 trace_id；无 Plugin 的 core CLI 才保留按 span tag 值反查的通用兜底。
5. 解析到 trace_id 后先查询 span 总数，再用稳定排序和 `search_after` 分页下载全量 `_source`，逐页追加到 `spans.jsonl` 并累计统计。
6. Render 使用 TypeScript trace-harness 将物理 span 归一化并聚合为逻辑节点树，再结合 Plugin 声明的
   业务 spec 生成交互式 HTML。
7. Evidence Worksheet 分别记录 ID 确认、计数、下载和 HTML 渲染状态；`--format bundle` 将全部证据
   归档，默认 `--format html` 只复制最终报告。
8. 交付结束后关闭 SearchEngine、回收 forward；下载中断时保留已经落盘的 span 和失败上下文。

## 关键设计

### Service 确认先于网络准备

Service 发现回答“本轮目标是谁”，属于配置确认；port-forward 回答“如何从本机访问”，属于网络准备。
两者分开后，Probe 不需要理解 Kubernetes，也不会在查询过程中隐式创建新通道。

### 计数和下载是两份证据

预先 count 既验证目标 trace 存在，也给全量下载提供完整性基准。下载条数与 count 不一致时仍保留
数据，但本次 Evidence 标为不完整；退出码表达证据完整度，不表达 trace 中是否存在错误 span。

### SearchEngine 保持协议通用

输入 ID 的业务解析策略、Jaeger 字段和摘要统计属于 Trace domain。OpenSearch client、鉴权、请求
超时和 search API 映射属于 infra。领域代码依赖 SearchEngine 契约，不把 Kubernetes 或官方 client
对象穿透到 Probe 和 Render。

### 业务语义由 Plugin 注入

trace-harness 只提供与 Python 版本一致的 span 归一化、逻辑节点融合、诊断和 HTML 渲染能力，不认识
具体 Plugin。节点分类与节点旁的业务摘要由 Plugin 提供 spec，因此任何业务节点和字段都不会进入通用
采集层。
