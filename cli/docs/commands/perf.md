# doctor perf 流量下的性能观测

`doctor perf` 观察系统在一段流量条件下的表现。自然流量已经能说明问题时，`--qps 0` 只观测；
需要额外流量时，再配置正 QPS。两者读取 Service、Operation 和 Workload 的 `observes` 声明来采集指标并生成 HTML Callgraph。

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
| `--case-dataset <csv>` | 正 QPS 下为选中的 Case 提供参数，每次请求有放回地随机抽一行 |
| `--hold` | hold 观测秒数，必须大于 0。默认取 60 秒与匹配 target 最长抓取间隔的 4 倍中的较大值 |

CSV 首行是参数名，例如只提供 `query` 一列即可为声明该参数的 Case 更换问句。每行列数须一致，含逗号或换行的值用双引号包裹。
多 Case 共享一份 CSV，每个 Case 使用自己声明的列。每项参数依次从当前行、声明的 `source`、`default` 取值。
列存在时，空单元格作为空字符串处理。缺值在加压前询问一次，非交互运行时报告缺少的参数。
`command.tenant_id` 和 `command.user_id` 复用命令的身份选择。
`input` 的值可以是字面量，也可以在任意层级用 `{ $param: query }` 引用参数。
字符串保留原文，其他类型支持 JSON 形式的 `integer`、`number`、`boolean`、`array`、`object`、`null`。

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
`--abort-error-rate` 和 `--breaker-min-n` 控制注入请求的错误率熔断。Perf Harness 按已完成请求的业务判定累计失败数。
达到最少样本数且错误率达到阈值时，Doctor 立即在 stderr 打印触发快照和在途请求数，随后等待排空并生成报告。

观测开始后按 Ctrl+C 正常结束本轮：封闭实际观测窗口，正 QPS 停止发出新请求，在途请求按
`--graceful-stop` 预算收尾，随后采集指标并生成报告。收尾期间再次 Ctrl+C 只提示进度，不取消请求或报告。
回车不结束观测。观测开始前的准备与交互仍按普通命令取消处理；外部 AbortSignal 仍是任务取消。
手动结束不要求跑满原计划 hold，终端摘要显示实际时长，不能据此宣称验证了原计划。

在线运行（含 QPS=0）需要在当前 profile 配置 `metricdb.url`，或用 `--prometheus <url>` 指定本次地址。缺少地址时，命令在加载 Plugin、选择 Case 和发压前退出。
已配置地址时，开始前检查观测参数并展示覆盖缺口，缺少指标样本时仍保留请求事实。运行期间每 5 秒显示
已用时间、已发出、已结束和在途请求数，计数来自现有 runner 调用，不改变调度。结束后从 Harness
实际窗口输出停止原因、hold 时长、完成/成功/中断数与延迟分位数。

## 声明与职责

- Service.operations 声明 Operation、calls/mayCalls 和 `observes`。Core 汇总当前 Plugin 的全部 Service 构建全图。
- Service.cases 提供离线 CaseSet、Operation 引用和可选 runner；同一入口的不同输入仍指向同一 Operation。
- Core 选择 Case、确认加压影响并准备所需访问；Harness 拥有调度、窗口、查询计划、归约和报告。
- 观测指标的后端表达式和统计口径由 Plugin 声明；Toolbox 提供参数绑定与 MetricDB 客户端。

## 阅读 HTML 报告

一份报告对应本次运行的设定 QPS。各视图共用同一份运行证据。

- **Overview（概览）** 默认打开，展示执行状态、流量与窗口汇总、维度分组和指标覆盖缺口。
- **指标质量** 按 Service 展示 active targets 的 job、健康状态、抓取间隔，以及 Operation 观测表达式在压测前和本轮的证据。压测前按计划 hold 读取独立 selector 和采用 `[$window]` 的原始输入 selector，统计匹配时序数和每条时序的样本范围，写入 `perf.json.metricBaseline`。终端按 Operation 汇总基线缺口。错误率采用零值回退且分母有样本时，空分子不会计入缺口。空的必需输入只说明基线窗口没有匹配时序。查询超时或无法识别输入时保留未知。运行后按实际窗口展示空结果、直方图无事件、bucket 校验失败和量程溢出。运行前的数据不会用来断言本轮缺失的原因。
- **Metrics（指标）** 按请求 RED 和自定义指标展示时间序列。加压时，每张图的右轴叠加同一档位全部 Case 的在途请求数 `inflight`。完成吞吐按完成时刻统计。Operation 的服务端 QPS 包含其他匹配流量，纯观测时仍可有值。
- **Resources（资源）** 按 Service 展示 CPU 和内存的 usage、request、limit，加压时叠加相同的 `inflight` 曲线。可从左侧选择 Service，查看每项查询的样本或缺口。
- **Callgraph（调用图）** 从所选 Case 的入口 Operation 或显式选择的 Operation 出发，沿 `calls` 和 `mayCalls` 展开。用各节点在选定窗口的 RED 汇总值（请求速率、错误率、延迟）判断哪一段值得进一步排查。默认显示可达子图，可切换全图；共享节点只展示一次。

同一时间轴上的曲线有三种归属：

| 数据归属 | 读什么 | 多个 Case 同时运行时如何解读 |
|---|---|---|
| Case 的注入请求 | 压测器记录的请求、完成状态和延迟 | 单次请求可按 Case 分组。`inflight` 统计实际已发出且尚未结束的注入请求。纯观测时没有这条对照曲线。 |
| Operation 的指标 | MetricDB 查询的服务端 QPS、错误率、延迟及首包耗时等自定义指标 | 共用入口的 Case 共享该 Operation 的曲线。查询还可能匹配自然流量，不能据此拆算每个 Case 的贡献。 |
| Service Workload 的资源 | 同期副本与容器的 CPU、内存使用量及 request、limit | 按 Service 汇总。同一服务的多个 Operation 共用这份资源观测。 |

Operation 指标按声明分类：`red:qps`、`red:error_rate`、`red:p95` 对应 RED，`resource:cpu`、`resource:mem` 归入资源耗费，其余指标按原名展示。各 Operation 的同名指标分别展示。

Core 根据 Service 的 Workload 声明生成资源查询。多个 Workload 的 Service 同时显示各采样时刻匹配到的 Workload 数量范围，CPU 和内存按已定位的容器去重汇总。

Workload 名称限定在所属 Service 内；同一声明挂在不同目标上会生成独立的时间序列。要按目标过滤，可在查询中使用标签值占位符 `{{service}}`，以及对应目标的 `{{operation}}` 或 `{{workload}}`。这些值来自声明的逻辑名称，导出器的标签名与筛选条件由查询指定。

资源时间线按 Service 的 Kubernetes workload 汇总副本和容器，CPU 用 cores，内存用 MiB。usage、request、limit 分别成线。数据来自当前 profile 或 `--prometheus` 选定的 Prometheus/VM：cAdvisor 提供用量，kube-state-metrics 提供容器成员及配额。Service 定位使用 EndpointSlice 的 Pod 引用与 `kubernetes.io/service-name` 标签。该时刻查不到 EndpointSlice Pod 引用时，用同名 Endpoints 的地址关联同 namespace 内可唯一识别的 Pod IP。按标签定位的 Workload 依赖已导出的 Pod 标签。数据源需覆盖目标集群和命名空间。缺少成员映射、用量或配额时对应采样点留空。

所有已注册 Operation 的 `observes` 都参与观测。指标覆盖缺口记录在 Evidence Bundle 的 `perf.json` 的 `metricIssues` 中。
结束时按查询失败、未采集、趋势无可用点、窗口无可计算值和直方图无观测增量汇总，并标明其中属于入口
Operation 的项数。同一指标在趋势和多个汇总窗口中可能各有一条记录。压测前的基线将非入口
Operation 在回看窗口无匹配时序记为提示，入口缺必需时序、样本不足或查询未能核对仍告警。

## Profile 与证据

```yaml
metricdb:
  kind: victoriametrics # 或 prometheus；省略时识别后端
  url: https://metrics.example.net
  # collector:                 # 采集与查询分离时填写
  #   url: https://collector.example.net
  #   username: ...            # 使用采集器自己的认证
  #   password: ...
  # username: ...
  # password: ...
```

Profile 提供地址、必要认证和可选 `kind`。显式 kind 选择对应后端；省略时客户端用常量查询识别
Prometheus/VM。按 `type: metricdb` 与 `kind` 选择目标的 `observes` 声明；认证、连接和无法识别的响应
保留错误，不切换后端。旧 `prometheus` profile 字段需改为 `metricdb`，原有 URL 与认证字段可原样迁移。
`Operation.observes` 提供完整查询选择条件，Core 不从 Kubernetes namespace 或用户参数拼接范围；
`$window` 在汇总查询中绑定实际窗口。Operation 的趋势查询采用至少 60 秒的滚动窗口。有匹配的
active target 时取 60 秒与最长有效抓取间隔的四倍中的较大值，显式 `trendWindowSeconds`
优先。趋势点可能包含运行开始前的样本。查询并发、超时和响应大小由客户端统一限定。

在线 perf 选定 Service 后并行读取采集器的 config 和 active targets（`state=active`）API，共用 5 秒探测时限。默认使用查询端点；当查询走 VM 的 vmselect 时，可用 `metricdb.collector.url` 指向实际采集器，并按需单独配置其 `username/password`。省略 collector 时，两个 API 共用查询端点及其认证。用 `--prometheus` 切换至其他地址时，探测使用该地址。

未显式配置 collector 时，如果租户级 vmselect 的 targets API 返回不支持该操作的状态，Doctor 在同一探测时限内先查 VM Operator 管理的 VMAgent。如果没有候选，再查 vmselect 所在 namespace 里的 Prometheus server Service。Toolbox 用 VMCluster owner 或 vmstorage 节点集合核对 vmselect 与 vminsert，并从 Prometheus 当前加载的配置确认 remote_write 写入该集群和租户。每条路径都要求候选唯一且其 active targets 匹配当前业务 Service。对仅有 Pod 发现标签的 target，Doctor 读取对应 Kubernetes Service 的完整 selector 来匹配。多个候选、权限不足或目标不匹配时保留诊断提示并继续 perf。vmagent 自监控指标的 instance 只作为线索。显式 collector 适用于代理、NodePort、跨 namespace 的 Prometheus 和需要单独认证的部署。

Doctor 按 namespace 及 Service 或声明的 Workload 匹配 target，优先使用 active target 报告的间隔，缺少时按 scrapePool 查对应 job 的配置。显式 `--hold` 始终优先。探测失败时继续运行，查不到间隔时沿用 60 秒默认值。匹配结果、间隔来源、健康状态和 API 错误写入 `perf.json` 的 `scrape`，离线 HTML 可查看。

Evidence Bundle 的 `perf.json` 在 `scrape.metricdbUrl` 记录本轮选定的指标查询地址，在 `scrape.collectorUrl` 记录读取 config 和 targets 的采集器地址。后者来自显式配置、通过验证的自动发现，或直接复用查询端点。API 返回错误时仍可用地址与错误字段一起定位问题。两个字段均为 HTTP(S) base URL，凭据、query string 和 fragment 不写入这两个字段。

Evidence Bundle 的 `raw/scrape/config.yaml` 保存采集器返回的原始 YAML，`raw/scrape/targets.json` 保存启动探测时 `state=active` 的原始响应（上限 4 MiB），含所选 Service 以外的 active target、发现标签和 `scrapeUrl`。两个接口独立留存。发送压测包前请检查配置中的凭据、内部地址及标签。

声明观测指标只表示知道如何查询，不证明指标已写入 Prometheus。每个 RED 指标分别保留有结果、
查询成功但无可用样本、查询失败或未采集的状态；兄弟指标成功时仍展示。无样本不补零，也不直接
归因为 scrape 故障。Perf 只读已有历史数据，不抓取服务 /metrics、不读取日志、不管理 scrape。

运行事实先保存，查询计划在指标 I/O 前冻结；`run.json`、`requests.jsonl`、`evaluations.json`、`perf.json`
保留窗口、入口、拓扑、注入事实和指标覆盖情况。请求统计及 Case/Facet 分组只在存在注入请求证据时展示。
QPS=0 的空请求集合不表示系统零流量或零延迟。缺少观测声明、缺样本、查询失败分别保留。

`--from` 只读取保存的事实，不加载 Plugin、Kubernetes、Runner 或指标源，输出写入新 Artifact。

## 结果边界

Run.status 表示执行完成度；指标未取得或查询不完整使命令 partial。自然观测没有观测声明时也为 partial。
静态 calls/mayCalls 不证明某条边实际发生；节点指标不按 Case 拆分，不把自然流量归因于加压。
HTTP 成功不代表 SSE 业务成功，路径上的延迟分位数不能相加。
