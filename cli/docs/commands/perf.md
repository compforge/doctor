# doctor perf 主动性能诊断

`doctor perf` 按所选 Case 产生受控负载，再查询外部 Prometheus / VictoriaMetrics 的对应历史窗口，
交付请求统计与 Operation Callgraph。执行前展示并确认目标、Case、并发、时长、熔断和业务影响。

## 声明与职责

- Common `Operation` 静态描述 Service 能力，携带 `calls`、`mayCalls` 和 `probes`；`Service.operations`
  贡献目录。Core 将各 Service 绑定到本次 Environment，校验所有权与引用并组装全局 Graph。
- `Service.cases` 提供 CaseSet、可选 producer 和单请求 runner。source 的 `operation` 静态引用
  同一 Service 的入口能力；不同输入仍指向同一 Operation，见 [Operation 与 Case](../plugin.md#case-与-operation)。
- `perf.scenarios` 只提供实验预设及 `cases: { service, source }`，不再列出 Metric/Log Service。
- Core 选择 Cases、授权、准备访问和调度。Runner 每次只发起一笔请求，拥有协议、鉴权与原始 Outcome；
  Judge 独立分类。Perf Harness 拥有 Stage / Window、查询计划、归约和 Callgraph 渲染。
- Probe 声明属于 Common；PromQL 参数绑定及 Prometheus 客户端属于 Toolbox；后端变体由声明显式提供，
  选定后不自动降级或重写表达式。Profile 提供访问凭据、并发、超时、响应大小上限和各 Service 标签值。

Perf 不抓取 Service `/metrics`，不启动 Prombed，不自动采集日志或 Trace。Outcome 的业务/Trace ID
保留在原始记录中，供后续显式诊断使用。独立的 metric、log、trace 命令维持各自职责。

## 执行与离线复查

```bash
doctor perf --service app --scenario ordinary --caseset chat --cases greeting,python \
  --levels 1,5 --ramp 10 --hold 60 --prometheus https://metrics.example.net

doctor perf --from ./saved-perf --format html
```

并发最高 50，默认档位 5、10、15、20；交互入口可选最高并发 1、5、10、20、50。
多 Case 等权随机抽取；Case 不携带并发或环境配置。`--abort-error-rate` 与 `--breaker-min-n`
共同控制错误率熔断，`--graceful-stop` 限制正常收尾。Ctrl+C 传播取消并保存已有证据。

请求事实先落盘；查询计划在任何指标 I/O 前冻结，包含来源、后端、表达式与窗口。
`run.json`、`requests.jsonl`、`evaluations.json` 和 `perf.json` 不依赖是否选择 HTML。
Service.operations 是唯一声明源，Graph 与 Observation 在内存组装，不维护独立声明 JSON/YAML。
Run 保存本次拓扑与查询证据；Callgraph 视图从这些事实临时投影，不另存 Graph 文件。
报告保留 Case/Facet 与首 token 统计；Callgraph 将窗口指标投影到 Operation。

Operation 声明 probe 且 Doctor 配置了 Prometheus/VM 时，正常 Perf 运行自动采集对应窗口的指标，
无需额外开关。未配置来源、某个 Operation 参数不全、后端不可用或部分查询失败时保留请求事实与
已取得的指标，报告记录覆盖缺口，不阻止其他 Operation 的有效查询。没有 probe 时只运行请求。

`--from` 只离线读取已有事实，不加载 Plugin、不准备 Kubernetes、不调用 runner，也不访问指标源。
输出写入新的 Artifact，原目录保留。

## Profile 示例

```yaml
prometheus:
  url: https://metrics.example.net
  kind: prometheus # 或 victoriametrics
  concurrency: 4
  timeout_ms: 30000
  max_response_bytes: 4194304
  parameters:
    app:
      namespace: test
```

`{{name}}` 只绑定经过 JSON 字符串转义的标签值，`$window` 由 Perf 绑定到本次窗口。
缺少必需参数、后端变体缺失或同一 metric role 出现多个 producer 时，跳过该 Operation 的指标
并记录原因；不会猜测标签或改写表达式。

## 结果边界

Run.status 表示负载执行完成度；查询失败或已计划指标缺样本使命令结果为 partial，取消为 cancelled。
实测零值、缺样本和查询错误分别保留。没有 Probe 的 Operation 显示 N/A。
静态 calls / mayCalls 不证明某条边实际发生；服务端指标可能包含匹配的其他流量，不能归因到单个 Case。
HTTP 成功不等于 SSE 业务成功，路径上的延迟分位数不能相加。
