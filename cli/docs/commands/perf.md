# doctor perf 流量下的性能观测

`doctor perf` 观察系统在一段流量条件下的表现。自然流量已经能说明问题时，`--qps 0` 只观测；
需要额外流量时，再配置正 QPS。两者按 Operation 的 Probe 采集指标并生成 HTML Callgraph。

## 选择与参数

Plugin 可通过 `perf.defaultService` 指定候选 Service 的默认值，可通过 `-s/--service` 指定。
QPS 为 0 时直接选择观测 Operation。正 QPS 时按 CaseSet 分组展示所选 Service 可执行的 Case，
可跨组多选。每次发送等概率抽取一个 Case，总目标 QPS 由所有选中 Case 共享。
Case 来源绑定同一 Operation 时默认使用该入口，也可通过 `--operation <id>` 指定观测入口。
`--cases` 接受逗号分隔的 Case ID，重名时使用 `source/caseset/case`。

| 参数 | 含义 |
|---|---|
| `--qps` | Harness `request_rate`，配置的加压速率，默认 0 |
| `--max-inflight` | 正 QPS 下 Harness 未完成请求的上限，默认 20；QPS=0 不需要配置 |
| `--hold` | hold 观测秒数，默认 60，必须大于 0 |

加压 QPS、实际发出 QPS、服务吞吐 QPS 分别记录。达到在途上限后，实际发出速率可能低于配置；
服务端吞吐由系统实际表现决定，包含指标选择器匹配的自然流量。DB、VDB、模型等下游性能均可能影响它，
不能仅凭吞吐与加压值的差推断某个瓶颈。

```bash
# 只观测，不要求业务租户、Runner 或 Kubernetes 访问
doctor perf -s example-api --operation operation:example-api/chat --qps 0 --hold 300

# 叠加受控业务请求；执行前确认目标和影响
doctor perf -s example-api --cases lookup,summary --qps 5 --max-inflight 20 --hold 60

# 离线重新生成报告
doctor perf --from ./saved-perf --format html
```

QPS=0 只执行 hold，不进行 setup/warmup/cooldown/cleanup，不初始化业务 runner、请求身份或业务访问。
正 QPS 按 setup → warmup → hold → cooldown → cleanup 执行；多 Case 等权随机抽取。
`--ramp` 控制 warmup，`--graceful-stop` 限制等待在途请求的时间，
`--abort-error-rate` 和 `--breaker-min-n` 控制注入请求的错误率熔断。

观测开始后按 Ctrl+C 正常结束本轮：封闭实际观测窗口，正 QPS 停止发出新请求，在途请求按
`--graceful-stop` 预算收尾，随后采集指标并生成报告。收尾期间再次 Ctrl+C 只提示进度，不取消请求或报告。
回车不结束观测。观测开始前的准备与交互仍按普通命令取消处理；外部 AbortSignal 仍是任务取消。
手动结束不要求跑满原计划 hold，终端摘要显示实际时长，不能据此宣称验证了原计划。

开始前检查指标源及 Probe 参数并展示覆盖缺口；缺少指标时继续保留请求事实。运行期间每 5 秒显示
已用时间、已发出、已结束和在途请求数，计数来自现有 runner 调用，不改变调度。结束后从 Harness
实际窗口输出停止原因、hold 时长、完成/成功/中断数与延迟分位数。

## 声明与职责

- Service.operations 声明 Operation、calls/mayCalls 和 Probe。Core 汇总当前 Plugin 的全部 Service 构建全图。
- Service.cases 提供离线 CaseSet、Operation 引用和可选 runner；同一入口的不同输入仍指向同一 Operation。
- Core 选择 Case、确认加压影响并准备所需访问；Harness 拥有调度、窗口、查询计划、归约和报告。
- Probe 的后端表达式和统计口径由 Plugin 声明；Toolbox 提供参数绑定与 MetricDB 客户端。

HTML 与 eval-perf 一样分为两个 tab：Report 展示观测概况、指标和适用的请求统计；Callgraph 展示调用图。
所有已注册 Operation 的 Probe 都参与观测。Callgraph 默认显示 所选 Operation 的可达子图，沿 calls/mayCalls
展开，可切换全图；两种视图使用同一批证据。共享节点与环不会复制或改变身份。

## Profile 与证据

```yaml
metricdb:
  kind: victoriametrics # 或 prometheus；省略时识别后端
  url: https://metrics.example.net
  # username: ...
  # password: ...
```

Profile 提供地址、必要认证和可选 `kind`。显式 kind 选择对应后端；省略时客户端用常量查询识别
Prometheus/VM。按 `type: metricdb` 与 `kind` 选择 Operation Probe；认证、连接和无法识别的响应
保留错误，不切换后端。旧 `prometheus` profile 字段需改为 `metricdb`，原有 URL 与认证字段可原样迁移。
Operation Probe 提供完整查询选择条件，Core 不从 Kubernetes namespace 或用户参数拼接范围；
`$window` 由 Harness 绑定实际窗口。查询并发、超时和响应大小由客户端统一限定。

声明 Probe 只表示知道如何查询，不证明指标已写入 Prometheus。每个 RED 指标分别保留有结果、
查询成功但无可用样本、查询失败或未采集的状态；兄弟指标成功时仍展示。无样本不补零，也不直接
归因为 scrape 故障。Perf 只读已有历史数据，不抓取服务 /metrics、不读取日志、不管理 scrape。

运行事实先保存，查询计划在指标 I/O 前冻结；`run.json`、`requests.jsonl`、`evaluations.json`、`perf.json`
保留窗口、入口、拓扑、注入事实和指标覆盖情况。请求统计及 Case/Facet 分组只在存在注入请求证据时展示。
QPS=0 的空请求集合不表示系统零流量或零延迟。未声明 Probe、缺样本、查询失败分别保留。

`--from` 只读取保存的事实，不加载 Plugin、Kubernetes、Runner 或指标源，输出写入新 Artifact。

## 结果边界

Run.status 表示执行完成度；指标未取得或查询不完整使命令 partial。自然观测没有 Probe 时也为 partial。
静态 calls/mayCalls 不证明某条边实际发生；节点指标不按 Case 拆分，不把自然流量归因于加压。
HTTP 成功不代表 SSE 业务成功，路径上的延迟分位数不能相加。


Report 同页按入口 Operation 展示本轮选中的 Case。请求时延、首个输出和完成吞吐按 Case 归属；
入口 Operation 的 RED 及其他指标覆盖匹配的服务端流量。Callgraph 从所有入口展开，共享下游合并。
完整覆盖缺口保存在 Evidence Bundle 的 `perf.json`（`metricIssues`）。范围查询使用已有 metricdb 时序。
