# Doctor Case

## 理念 / 概念

Case 是可复用的请求输入，沿用 spec-case 的 canonical CaseSet YAML。`doctor case` 列出内置、Plugin 和当前目录 `doctor-case.yaml` 中的 Case；交互选择一个或多个 HTTP Case 并确认发送，或在非交互调用中使用 `--send`。`doctor model` 和 `doctor perf` 从同一目录选择与命令匹配的 Case。选择发生在执行命令时，CaseSet 不保存本次选择。

`facets.command` 声明 Case 的用途：`http`、`model`、`perf` 或 `both`。一个 CaseSet 可以同时包含不同用途的 Case。Doctor 按命令过滤候选，执行时只读取选中的 Case。内置 Model Case 覆盖 LLM、Embedding、Rerank 连通性和 LLM 轻量性能采样；内置 HTTP Case 提供基础 GET 探测。Plugin 的 `case.runner.create` 可以提供业务 CaseSet；当前目录的 YAML 可补充现场 Case。

```yaml
caseset: doctor_smoke
schema_version: 1
facets:
  command: {values: [http, model, perf]}
  mode: {values: [connectivity]}
cases:
  - id: health
    input:
      method: GET
      path: /health
      expect: {status: 200}
    facets: {command: http}
  - id: model_messages
    input:
      path: /chat/completions
      body:
        messages:
          - {role: system, content: Answer briefly.}
          - {role: user, content: Hello}
    facets: {command: model, mode: connectivity}
  - id: chat_load
    input: {query: Hello}
    facets: {command: perf}
```

HTTP Case 的 `input` 是一个请求：`path`、method、headers、`json`/`body`/`body_file`、响应 `expect` 和可选 Entrypoint。`--base-url` 提供本次目标的 scheme、host 和 port；Case 不保存 URL 或目标凭据。Model Case 的连通性输入使用 `path` 与 `body`，模型 ID 由 Model Capability 注入。Perf Case 的输入交给所选 Service 的单请求 runner 解释；Case 不保存并发、速率和权重。

## 流程

1. `doctor case` 只读列出可用 Case。交互终端可选 CaseSet 和一个或多个 HTTP Case，再确认是否发送、提供目标 base URL 和请求执行位置。非交互使用 `doctor case --send --caseset doctor_smoke --cases health --base-url http://127.0.0.1:8000`。
2. 发送复用 HTTP Collect：从本机或指定 Pod/Container 发起请求；先 Inspect 目标 host:port 的 DNS/TCP，再串行执行选中的 Case。`--repeat` 控制轮次，`--interval` 控制轮间等待。每次请求保留状态、headers/body、传输阶段耗时和可选 SSE 时间线。
3. Detector 依据传输完整性、HTTP 状态、Content-Type、耗时和 SSE 终态产生 Findings；同一 Case 的多轮结果可识别偶现失败。报告保存实际 Request Plan 的可复现 cURL，异常响应可在 HTML/Markdown 查看，完整原始证据进入 Bundle。
4. `doctor model` 按序执行选中的连通性 Case，逐 Case 记录 Observation 和失败归因；选中的轻量性能 Case 串行采样。`doctor perf` 把选中的 Case 交给 Perf Harness；多选时每次 dispatch 等权随机取样，预算、并发和熔断仍由 Perf 命令控制。

## 关键设计

Case 描述“发什么”，命令提供“发向哪里、发多少”。这让同一个 CaseSet 可以用于不同环境，也让报告中的 Case ID 保持稳定。`doctor case` 只发送 HTTP Case；模型目标需要租户、模型目录和 Inference Capability，由 `doctor model` 负责；Perf 的业务鉴权和请求协议由 Plugin runner 负责。

HTTP Collect 区分证据采集完整与请求成功。完整采到 HTTP 500 时，Finding 会记录失败，但报告仍可完整交付；DNS 不可达、传输中断或产物失败会使覆盖不足。Pod 模式从目标 Container 使用 curl，本机模式使用 Got；两者都归一化为同一 Observation，Detector 不访问网络。

`doctor case` 支持多个 Case 顺序发送；它用于复现和连通性诊断。需要并发负载时使用 `doctor perf`，由 Harness 统一管理随机 Case mix、请求预算和停止条件。
