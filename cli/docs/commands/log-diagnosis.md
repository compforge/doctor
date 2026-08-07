# Log 采集设计

## 理念 / 概念

`doctor log --biz-id <id>` 是按业务标识聚合多 Service 日志的确定性 collect command。app 注入当前 Plugin；`collect/log` 先调用 `traceId` capability 把业务 ID 解析为规范 `trace_id`，再从通用 Service Catalog 选择具备 log capability 的 Service，并读取各声明的默认主链策略。它不 import 业务 Plugin 或识别具体 Service 名。`infra/k8s` 只负责按 Kubernetes Service selector
解析 Running Pod，并读取 Pod 日志。

采集链路包含三层用途不同的产物：

- `timeline.jsonl` 是过滤后日志的结构化时间线，保留 Service、Pod、Container、current/previous、时间戳和消息；它是文本与 HTML 展示的共同输入。
- `service-logs.txt` 与 `report.html` 分别面向纯文本阅读和交互排查，二者不重新解析 raw 日志。
- `raw/` 保留逐 Pod 的 kubectl 原始 stdout，作为可复查证据，不被聚合或过滤结果替代。

## 流程

1. 配置确认先确定 Namespace，并由 `service.traceId` provider 把 `--biz-id` 解析为规范 `trace_id`，输出 provider 与本次映射。非交互使用 Catalog 的默认日志主链；交互候选是统一 Catalog 与当前 Namespace 实际 Service 的交集。时间范围优先采用显式参数；未指定时，近期 UUIDv7 业务 ID 会提供带少量前置余量的日志起点，其他 ID 回退默认回看窗口。
2. Inspect 通过 `KubernetesPodLogAccess` 读取 Service、Pod 和 Container status，按 selector 建立 Service → Running Pod 关系，并确认哪些容器存在可读取的上一次终止实例。
3. 每个 Service 独立运行一个 Probe；Probe 对其 Pod 采集同一时间范围内的 current 日志，并对发生过重启且存在 `lastState.terminated` 的容器 best-effort 补采 previous 日志。原始字节流分别直接落盘，同时按业务标识和可选错误模式生成 Observation。
4. Render 合并全部 Service Observation，生成带来源的 `timeline.jsonl`；纯文本与 HTML 都消费这份结构化时间线。
5. 命令默认交付单文件离线 HTML；`--format bundle` 同时保存 manifest、结构化时间线、聚合文本、HTML、摘要以及逐 Pod raw 日志。单 Pod 失败只降低本次证据完整度。

当前没有独立 Detector：命令负责定位和整理日志证据，不把日志文本模式直接解释成根因。

## 关键设计

### Service 选择是业务策略，selector 解析是基础能力

有哪些 Service 属于 Plugin 知识，只在对应 Plugin 的统一 Catalog 定义；是否采集日志以及是否属于默认主链由各 Service 的 log capability 声明，
`collect/log` 不维护平行名单或按服务名分支。如何读取 Kubernetes Service、如何按 selector 找到 Pod、如何执行 `kubectl logs` 可被 MCP 等领域复用，因此属于
`infra/k8s`。通用多选交互属于 `terminal/`，不进入 infra。

### 一个 Service 一个 Probe

Service 是用户理解日志来源和后续扩展采集规则的稳定边界。单 Service 失败时，其它 Service 仍可
继续采集并进入时间线；Evidence 也能明确指出缺的是哪一段，而不是把一次多 Service 操作记成一个
不可拆分步骤。

### raw 完整性优先，聚合结果保持精简

逐 Pod raw 日志当前不做容量截断，而是从 kubectl stdout 流式落盘，避免日志大小同时转化为进程
内存占用。时间窗口和 Service 范围仍由配置确认限制；current 与 previous 分开记账，previous
不可用只形成证据缺口，不让 current 采集失败。全局时间线保留匹配业务标识和过滤条件的日志；
异常首行命中后还会连续保留常见 Python、JavaScript、Java 和 Go 堆栈续行，并把错误首行与续行组成一个逻辑日志事件。时间线排序、计数和筛选都以事件为粒度，事件消息仍保留换行供文本与 HTML 多行展示。raw 与时间线不能互相替代。

### HTML 是结构化时间线的离线阅读器

HTML 报告不依赖网络或外部静态资源。日志保留在页面内的结构化数据中，浏览器只挂载当前页，避免把整份日志一次性展开成大量 DOM。阅读器提供关键字搜索、常用异常关键字、Service/Pod、起止时间、可点击时间分布、命中跳转和同一容器实例的上下文查看；这些交互只改变展示，不修改或取代 `timeline.jsonl` 与 raw 证据。
