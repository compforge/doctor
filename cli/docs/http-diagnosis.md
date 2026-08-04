# HTTP 场景重放与诊断

## 理念 / 概念

`doctor http` 是确定性的 HTTP 场景重放命令。一个 YAML 文件声明一个或多个请求，doctor 可以从本机或指定 Kubernetes Pod/Container 串行执行多轮，保存每次响应，并对单次结果和跨轮稳定性进行规则分析。本机模式不消费 profile 的 Kubernetes 能力；Pod 模式只使用 profile 中的 namespace / kubeconfig，不连接 doctor-server，也不调用 LLM。

核心对象按 collect 协议分层：

- **Execution Target**：请求的发起位置；`local` 表示 Doctor 本机，`pod` 表示由本机 Doctor 通过 `kubectl exec` 在选定 Container 内发起。
- **Scenario**：一份 `doctor-http/v1` 文件，是本次诊断目标。
- **Request**：一个逻辑请求，method、body、公共 header、采集预算和响应预期只声明一次。
- **Entrypoint**：同一逻辑请求进入调用链的不同入口，只覆盖 URL、入口专属 header 和 redirect 行为。声明顺序表达调用链由外到内，例如 `entry-a → entry-b → api`。
- **Endpoint Fact**：Inspect 从实际执行位置对场景 URL 去重后的 `host:port` 做 DNS/TCP 连通性检查，记录解析地址、连通状态、阶段、耗时与失败原因。
- **Probe**：只有 Endpoint Fact 不确认不可达时，才执行某个 Request/Entrypoint 的真实 HTTP 请求。
- **Observation**：每次 Probe 保存 response header/body、正文 SHA-256、传输终态、DNS/TCP/TLS/TTFB 等阶段耗时、实际连接地址、起止时间和 SSE frame 时间线。
- **Diagnosis**：Detector 只消费 Facts 与 Observations，形成单次 Findings、跨轮稳定性、相邻 Entrypoint 差异和 Coverage。

示例：

```yaml
schema: doctor-http/v1
name: reproduce-api-flaky

timeout_seconds: 60
max_response_mib: 32
follow_redirects: true
headers:
  Authorization: Bearer xxx

requests:
  - id: create-item
    method: POST
    url: https://api.example.test/v1/items
    headers:
      Content-Type: application/json
    json:
      message: hello
    entrypoints:
      - id: entry-a
        headers:
          Host: api.example.test
      - id: entry-b
        url: https://entry-b.example.test/v1/items
        headers:
          Host: entry-b.example.test
      - id: api
        url: http://api:8000/v1/items
        headers:
          Host: api
    expect:
      status: [200]
      content_type: application/json
    compare:
      body: none
      sse_events: false

  - id: health
    url: https://example.test/health
    expect:
      status: 200
      max_duration_ms: 1000
```

Request 必须声明基础 `url`。没有 `entrypoints` 时，doctor 将它归为 `default` Entrypoint；需要对比时声明两个或更多 `entrypoints`，每个 Entrypoint 可以省略 `url` 以继承 Request，也可以覆盖 URL、header 和 redirect 行为。Request 的公共 headers 先继承 Scenario 根级 headers，再由 Entrypoint 的同名 header 覆盖，因此 Host、入口鉴权等差异不需要复制公共 body。场景与 Request 同名采集参数的优先级为 CLI 覆盖、Request、Scenario 根、Doctor 内置值。

请求 body 支持 `json`、`body`、`body_file` 三种互斥形式；`body_file` 相对场景文件解析。v1 不提供请求间变量传递、并发或脚本执行。

## 流程

1. 交互终端首先选择请求执行位置 `local` / `pod`；非交互环境默认 `local`，也可用 `--location pod` 或直接指定 `--pod`。Pod 模式随后复用 collect 公共流程依次确认 namespace、Pod 和 Container，显式 flag / profile 已确定的值不重复询问。
2. `doctor http --example [path]` 可生成一份可执行的 `doctor-http/v1` 示例，默认写入当前目录的 `example.yaml` 且不覆盖已有文件。执行时可显式传入 `--file <path>`；交互终端未指定文件时，Doctor 扫描当前目录并只保留通过 schema 校验的 YAML，唯一候选会打印文件名并自动选择，多个候选才进入选择；非交互环境仍要求显式传入 `--file`。
3. Doctor 解析并完整校验场景；交互终端默认不选中 request，支持按序号一次切换一个或多个请求，非交互调用可用 `--request <id1,id2>` 显式筛选；CLI 的 timeout / size 参数只作为本轮全局覆盖。
4. Inspect 从实际执行位置并发检查去重后的 URL `host:port`，单 endpoint 默认预算 3 秒，可用 `--inspect-timeout` 覆盖。local 直接执行 DNS lookup + TCP handshake；Pod 在目标 Container 内使用不携带业务 headers/body 的 `HEAD <origin>/` 确认 DNS/TCP，任何 HTTP status 都只表示 endpoint 可达。
5. Facts 冻结后进入 Probe 调度。明确 `unreachable` 的 endpoint 对应请求记为 unavailable，不再等待完整 HTTP timeout；Inspect 本身异常而状态为 `unknown` 时仍允许真实 Probe 尝试，避免诊断工具能力不足造成假阴性。
6. 每轮先按 Request 顺序、再按 Entrypoint 从外到内的顺序串行执行，轮次之间可通过 `--interval` 等待；单个入口失败不会中断后续入口或轮次。
7. local transport 使用 Got 流式请求并记录 socket、重定向与阶段耗时；Pod transport 通过 `kubectl exec` 运行业务 Container 内的 curl，并在版本支持时用 `--write-out` 记录实际地址和阶段耗时。两者都在本机还原为统一响应协议，response body 通过 `ReadableStream` 边接收边落盘，显式 timeout 与单响应容量限制负责终止边界。
8. 每条 Probe Observation 按 `round/request/entrypoint` 独立保存 `headers.txt`、`body.*`、可选 `error.txt` 和 `meta.json`；SSE 同时建立不含正文的 frame 索引，记录首末 frame、P95/最大间隔和 `[DONE]` 终态。
9. Detector 校验 endpoint 可达性、单次传输、HTTP status、Content-Type、最大耗时和 SSE 事件，并按 Entrypoint 聚合成功率、状态分布、延迟分位数和偶现失败。Detector 不访问网络。
10. 同轮比较按 Entrypoint 声明顺序逐对进行。若 `entry-a` 与 `entry-b` 不同、`entry-b` 与 `api` 相同，Finding 将差异区间收敛到 `entry-a → entry-b`，但不在缺少日志/trace 时武断断言具体根因。
11. HTML 是默认产物，HTML 和 Markdown 都会交付最终 Request Plan 对应的可复现 cURL，并对未满足预期的执行展示有界的实际 Response；显式选择 Bundle 时会同时包含未截断的完整原始响应和离线 `report.html`。报告和 manifest 都记录实际执行位置、Inspection Facts、Observations、Findings 和 Coverage。

## 关键设计

### 为什么保留统一 HTTP transport

输入已经是结构化 HTTP Request，collect 不依赖具体执行工具。local transport 使用 Got，避免要求 Doctor 本机安装 curl，并取得 Fetch 不稳定暴露的 socket 与阶段耗时；Pod transport 使用目标 Container 内的 curl，并通过 `infra/http` 还原为相同的 status、headers、流式 body 和 transport diagnostics。采集、SSE、detector 与 render 因此不感知执行位置。

Pod 模式要求所选 Container 可执行 `curl`，Doctor 会在场景执行前检查版本。curl 7.63 及以上通过 stderr write-out 额外采集 DNS/TCP/TLS/TTFB、local/remote address、最终 URL、重定向次数和传输字节；更老版本保持 status/header/body 基础采集，不因缺少增强字段拒绝请求。Doctor 不会把 binary 或 YAML 复制进 Pod，也不留下远端文件。Pod 内各 Container 共享 network namespace，但 CA 文件、代理环境变量和文件系统并不共享；需要复现这些条件时应选择实际持有对应运行时配置的 Container。

Pod endpoint Inspect 强制绕过代理，只探测声明 URL 的 origin，不携带场景鉴权 Header、Request body 或路径。由于 Pod 内不保证存在 `nc`、Python、Node 或支持 `/dev/tcp` 的 shell，当前复用已要求的 curl 发送语义安全的 HEAD；即使服务返回 401、404 或 405，只要 TCP 已建立就视为可达。redirect 的新 endpoint 只有在场景中显式声明时才会提前 Inspect，运行时动态跳转仍由 HTTP Probe 记录。

### 为什么串行执行

该命令用于复现偶现问题而不是压测。每轮顺序稳定能避免并发本身改变目标行为，也让 `request_id + entrypoint_id + round` 唯一定位一次现场。后续若增加并发，应作为明确的执行模式，而不是修改默认语义。

### 为什么是 Entrypoint 而不是 tag

tag 只能说明几条请求“有关”，表达不了哪些字段应该相同、哪些字段允许变化，也不能定义比较顺序。Entrypoint 明确约束它们属于同一个逻辑 Request：method/body/expect 共用，URL/header 可以覆盖；声明顺序同时给 detector 一条由外到内的调用链，使响应差异能够落到相邻区间。

### 响应如何比较

同轮相邻 Entrypoint 默认比较 `capture_complete`、HTTP status、Content-Type、传输终态、请求成功状态，以及 SSE event 序列。这些都是跨入口应稳定、且不依赖业务正文动态字段的语义。

每次响应都会记录 body SHA-256，便于人工核对；只有显式设置 `compare.body: exact` 时，SHA-256 不同才形成 Finding。默认 `none` 是因为 response 常包含动态 ID、时间戳和 token，逐字节变化不能自动解释为链路异常。`compare.sse_events` 默认开启，只比较 event 序列，不比较 SSE payload 正文。

SSE 的 framing 与时间线分析位于 `collect/shared/http`，因此普通 HTTP 响应仍走原有 status/body 路径，`text/event-stream` 响应则额外获得通用流指标。shared 层不解释 OpenAI token、AS UI Event 等业务语义；调用方可基于同一 frame 观测继续做领域分析。

### 为什么区分采集完整与请求成功

`capture_complete` 表示 doctor 是否完整取得响应证据，`request_success` 表示响应是否满足声明的预期。HTTP 500 可以是 `capture_complete=true`、`request_success=false`；网络超时则两者都为 false。Finding 是否存在不决定进程退出码：完整采到 HTTP 500 并成功交付报告时退出码仍为 0；endpoint 不可达、传输中断或产物交付失败导致必需证据不完整时退出码为 1。

### 为什么报告只嵌入异常响应

HTTP 4xx/5xx 等未满足预期的响应往往直接携带失败原因，所以 HTML/Markdown 展示 status、headers 和有界 body；正常响应仍只展示结构化摘要，避免多轮重放时报告被大量正文放大。Bundle 始终保留未截断的完整 header/body。由于报告中的 cURL 包含实际 header 和 body，产物继续以 `0600` 交付，应按敏感诊断证据处理。
