# Doctor Case

## 理念 / 概念

Case 是可复用的请求输入，沿用 spec-case 的 canonical CaseSet YAML。Service 通过 `cases` 贡献 Case 来源，与 DataSource、Workload 并列；每个来源集中持有离线定义及可选的运行时 producer、单请求 runner。`doctor case` 按 Service 列出其贡献的 Case；当前目录 `doctor-cases.yaml` 的输入也必须绑定到一个已声明 Service。交互选择一个或多个 HTTP Case 并确认发送，或在非交互调用中使用 `--send`。选择发生在执行命令时，CaseSet 不保存本次选择。

可执行性由协议决定：HTTP/Model 按输入协议筛选，Perf/Eval 使用来源 runner 的 `supports(case)`。Facet 描述用例分类，不承担命令路由。SDK 提供 LLM、Embedding、Rerank 连通性与流式性能采样模板，Service 显式贡献后才进入目录；Core 不注册 builtin Model/HTTP Case，也不创建虚拟 Service。

```yaml
caseset: doctor_smoke
schema_version: 1
facets:
  mode: {values: [connectivity]}
cases:
  - id: health
    input:
      method: GET
      path: /health
      expect: {status: 200}
  - id: model_messages
    input:
      path: /chat/completions
      body:
        messages:
          - {role: system, content: Answer briefly.}
          - {role: user, content: Hello}
    facets: {mode: connectivity}
  - id: chat_load
    input: {query: Hello}
```

HTTP Case 的 `input` 是一个请求：`path`、method、headers、`json`/`body`/`body_file`、响应 `expect` 和可选 Entrypoint。`--base-url` 提供本次目标的 scheme、host 和 port；Case 不保存 URL 或目标凭据。Model Case 的连通性输入使用 `path` 与 `body`，模型 ID 由 Model Capability 注入。Perf/Eval Case 的输入交给所选 Service 的单请求 runner 解释；Case 不保存并发、速率和权重。

## 流程

1. `doctor case` 只读列出可用 Case。交互终端可选 CaseSet 和一个或多个 HTTP Case，再确认是否发送、提供目标 base URL 和请求执行位置。非交互使用 `doctor case --send --caseset doctor_smoke --cases health --base-url http://127.0.0.1:8000`。
2. 发送复用 HTTP Collect：从本机或指定 Pod/Container 发起请求；先 Inspect 目标 host:port 的 DNS/TCP，再串行执行选中的 Case。`--repeat` 控制轮次，`--interval` 控制轮间等待。每次请求保留状态、headers/body、传输阶段耗时和可选 SSE 时间线。
3. Detector 依据传输完整性、HTTP 状态、Content-Type、耗时和 SSE 终态产生 Findings；同一 Case 的多轮结果可识别偶现失败。报告保存实际 Request Plan 的可复现 cURL，异常响应可在 HTML/Markdown 查看，完整原始证据进入 Bundle。
4. `doctor model` 按序执行选中的连通性 Case，逐 Case 记录 Observation 和失败归因；选中的轻量性能 Case 串行采样。`doctor perf` 把选中的 Case 交给 Perf Harness；多选时每次 dispatch 等权随机取样，预算、并发和熔断仍由 Perf 命令控制。`doctor eval` 默认逐例执行所选 CaseSet 的全部 Eval Case，一次一个请求，也可用 `--cases` 选择子集。

## 关键设计

Service Case source 是可被多个 Command 引用的资源，不是命令扩展的集合。离线 `load` 提供目录；
`CaseProducer` 绑定本次对象和目标；`CaseRunnerFactory` 创建由命令接管的单请求 runner。
三者由同一 `{ service, source }` 标识。Health 的消费关系与 Perf 的场景仍是各命令自己的 Extension。

原生操作与 Extension 共用 `PluginOperation` 的 access、PluginContext 和结果信封，因此不需要为使用
统一权限、客户端和清理机制而额外注册。producer 返回后释放调用上下文；runner factory 的上下文保留至
runner 清理完成。创建期间取消仍必须将已创建的 runner 交给生命周期所有者，不能在返回前丢弃资源。

Case 描述“发什么”，命令提供“发向哪里、发多少”。这让同一个 CaseSet 可以用于不同环境，也让报告中的 Case ID 保持稳定。目录发现不创建 runner 或连接 Target；`doctor case` 只发送 HTTP Case，模型目标由 `doctor model` 注入，Perf 的业务鉴权和请求协议由 Plugin runner 负责。当前目录默认读取 `doctor-cases.yaml` / `.yml`；本地文件通过 `--service` 指定已有 Service，只有一个 Service 时可唯一确定。

Health 通过自己的 `health.case.bindings` 关系选择共享来源，再由 producer 决定本次探测哪些 model、agent、file。
运行时 `subject` 标识被测业务对象，`targets` 保存新鲜地址、凭据与请求正文；两者不改变 canonical Case ID/hash。
同一用例可以绑定多个对象，执行实例是另一维度。Health、Perf 和 Eval 共享 Case 能力，各自负责体检、加压或证据采集。

HTTP Collect 区分证据采集完整与请求成功。完整采到 HTTP 500 时，Finding 会记录失败，但报告仍可完整交付；DNS 不可达、传输中断或产物失败会使覆盖不足。Pod 模式从目标 Container 使用 curl，本机模式使用 Got；两者都归一化为同一 Observation，Detector 不访问网络。

`doctor case` 支持多个 Case 顺序发送；它用于复现和连通性诊断。需要并发负载时使用 `doctor perf`，由 Harness 统一管理随机 Case mix、请求预算和停止条件。

## 列出提供与消费关系

`doctor case --list`（`-l`）列出 Case、提供方 Service、传递方 `via`、消费方 Service/Workload 和当前 URL。
列表从 `Service.cases` 加载定义，从 `health.case.bindings` 读取消费关系，再调用选中来源的 producer
获取本次样本。每个来源只解析一次；不创建 runner、不发送 Case 请求。
签名 URL 的查询参数脱敏，headers 和 body 不进入列表。无样本、权限失败或截断会保留关系并报告缺口。来源返回的运行时 Case 可以是离线目录的子集；已有样本时只展示实际返回的条目，不补未提供样本的模板。来源的准备失败或截断在缺口中汇总，不覆盖已经解析成功的行。

```sh
doctor case -l
doctor case --list -s bedbox --caseset kb_skill_download
doctor case -l --caseset kb_skill_download --tenant-id TENANT -f json
```

`-s/--service` 支持按提供方、传递方、消费方筛选；`--caseset` 和 `--cases` 缩小 Case 范围。
默认按提供方分组，每个 Service 一个 Markdown 表格，没有 builtin 分组；样本列区分同一 Case 绑定的多个模型或业务对象。`-f json` 提供结构化结果。列表解析 URL 可能读取配置、数据库或调用签名 API，需要环境权限。
Service 静态 Case 未提供目标时显示“静态定义，未绑定运行目标”；可用 `--base-url` 解析其相对路径。
`--list` 与 `--send` 互斥。URL 已解析只说明取得目标地址，连通性仍需执行 Case 验证。

`HealthCaseBinding.via` 是可选的有序 Service 名列表，记录 URL 的传递方；消费位置仍由绑定所属 Service
及 `workload` 决定。它不改变现有 curl 执行方式，也不证明中间 Service 或 hictld 的下载策略已通过。
