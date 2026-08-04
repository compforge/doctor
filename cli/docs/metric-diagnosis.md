# doctor metric 指标诊断

## 理念 / 概念

`doctor metric` 把“服务能提供什么诊断指标”与“现场是否有 Prometheus”分开。业务 Service 在 Catalog 的
Metric capability 中声明 `/metrics` endpoint、所需 metric family、图表 PromQL 和可选 Detector；Doctor
只负责采集、执行查询和生成单文件离线 HTML，不把任何产品指标口径写进通用采集器。

Metric capability 是潜在能力，查询结果才是本次运行事实。查询没有数据时报告保留缺口，不把“未观察到”
解释为“指标正常”。Detector 只消费已取得的 PromQL 结果，不访问外部资源。

## 流程

1. 从 Service Catalog 选择本次参与的 Metric Service，并确认 watch 窗口。
2. preparation 选择统一 `MetricQuerySource`：profile 或 `--prometheus` 提供地址时使用 remote source；
   否则通过 Service selector 找出全部 Running Pod，逐 Pod 建立临时 port-forward，并创建 embedded Prombed source。
3. Inspect 固化本轮 source Fact；`metric-window` Probe 对 embedded source 按窗口抓取 `/metrics`，remote
   source 则直接封口所选历史窗口。到此两种来源都表现为同一份可查询 source。
4. 每个 Service 的 query Probe 通过统一契约执行其声明的 PromQL，产出带成功、空数据或失败状态的
   Observation；Evidence 形成后，纯 Detector 与 Coverage 复用这些结果，不再访问 source。
5. Renderer 只消费 Diagnosis，把查询结果、采集缺口、Finding 和图表写入不依赖外部资源的 HTML。

`watch=0` 读取进程启动至今的累计快照；`1m`、`2m`、`5m`、`10m` 表示区间查询。没有外部
Prometheus 时 Doctor 会真实等待并抓取该窗口；使用外部 Prometheus 时直接读取最近窗口。交互模式还可选择
`Ctrl+C` 持续采集，用户中断后再封口报告。

## 关键设计

### 为什么优先使用现有 Prometheus

Prometheus 已保存历史、处理 counter reset，并可能聚合多个副本。Doctor 直接消费它能得到更完整的数据；
但客户网络不一定允许 Doctor Host 访问 Prometheus，因此这条路径不是前置条件。

### 为什么 embedded source 按 Pod 采集

`/metrics` 是进程内快照，经 Service 访问只会随机命中一个副本。embedded source 因此借鉴 ServiceMonitor
的 target discovery：Service 只负责通过 selector 发现后端，Doctor 实际抓取每个 Running Pod，并注入
`pod` 标签保持各副本时序独立；业务 PromQL 再按原有聚合口径合并这些 target。

### 为什么 fallback 是 Prombed 而不是临时 Prometheus 进程

Prombed 只实现 Doctor/Perf Harness 当前需要的 Prometheus exposition、短期内存存储和 PromQL 子集，不要求
现场安装二进制，也不会留下常驻组件。每个 target 都按 capability 的 metric family allowlist 采集，并设置
超时、响应体、series 和 sample 上限。

remote 与 embedded 的协议适配、存储和抓取原语统一归 `infra/metric`；Collect 只选择数据源、控制 watch
窗口并消费统一的 query/queryRange 契约，不直接依赖 Prombed 或 Prometheus HTTP client。

### 为什么 PromQL 与 Detector 由 Service 声明

只有业务服务知道稳定指标名、label 口径和告警阈值。Doctor 提供统一图表类型与比较协议；Service 声明
PromQL 后，同一份契约既能查询外部 Prometheus，也能查询内嵌 Prombed，避免两条数据源形成两套规则。
