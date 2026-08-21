# doctor perf 主动性能诊断

## 理念 / 概念

`doctor perf` 回答“逐档提升并发时，普通业务请求从哪一档开始变慢，慢在哪里”。交互运行会让用户从
1、5、10、20、50 中选择最高并发，默认 20；自动化运行可通过 `--levels` 显式指定不超过 50 的档位。
Perf 是带自身加压动作的组合工作流：它拥有负载执行和 Perf Artifact，同时触发 Metric、代表请求的 Trace
和 Log；这些产物最终由统一 Delivery 一起交付。

Perf 是与 Provision、Collect、Chat 平级的顶层工作流。它会产生真实业务数据、Trace 和可能的模型费用，
因此执行前必须展示最大请求量、并发档位、熔断条件和影响并取得确认。

## 职责边界

- 语言中立的 Perf Harness 契约定义 Case、Arm、Trial、Stage、Window、Outcome 和落盘 IR；Python 与
  TypeScript 是两个平级实现，互不作为对方的规范。
- Doctor Core 使用 TypeScript 实现调度负载、限制请求数、按 dispatch 时间归窗，并写出
  `run.json` / `outcomes.jsonl`。
- Service `case` capability 直接提供 spec-case canonical CaseSet，以及并发安全的单请求 runner；
  `perf` capability 只选择一个或多个 Case、声明本次权重、关联键优先级和可观测 Service 清单。Case
  不携带环境、凭据、并发度或权重。
- CaseSet 用受控 Facet 词表声明 `difficulty`、`task_type` 等分类轴；Case 只选择每个轴上的值。
  spec-case 统一校验完整资产，Perf Harness 按 Facet 归约性能数据，避免用自由字符串形成不可维护的报告维度。
- HTTP/SSE 私有字段、鉴权、连接复用和首 token 语义留在 Plugin runner，Core 不认识某个产品的 Chat
  body、身份 header 或业务 ID 语义。
- Case 需要租户/用户身份时，由 Plugin 声明目录 Service 并读取自身 profile 配置；Core 复用
  `tenantDirectory` 补齐缺失的租户和用户选择。用户目录按关键词和页码查询，Plugin 必须在业务目录侧
  执行筛选与分页，不能先聚合全量用户；IAM 等私有查询协议仍留在 Plugin。
- “如何加压”分成两个所有者：Core 决定何时 dispatch、并发多少、何时停止；每个 dispatch 如何变成一笔
  真实业务请求由 Plugin runner 决定。Runner 可以在 Trial 生命周期内 setup/cleanup，但不能自行启动隐藏
  的请求循环，否则 Core 无法执行预算、熔断和 Window 归属。
- `doctor metric`、`doctor trace`、`doctor log` 仍分别拥有三个可观测数据面的采集与报告；Perf 只负责
  统一窗口，并把 Plugin 声明的业务 ID 交给既有 `traceId` resolver 做关联。

## 流程

1. 校验 Plugin 同时提供 Case、Perf、Metric、Trace ID 和 Log capability，选择 Service 与 scenario，并
   从其 CaseSet 解析 Case mix。
2. 交互运行选择最高并发；按需从 Plugin 声明的目录选择租户，再通过服务端关键词搜索和分页选择用户；
   随后展示并确认并发档位、每档最大请求数、错误率熔断和持久数据影响。非交互运行默认使用
   5、10、15、20 四档，并必须由 Plugin profile 提供身份。
3. 先启动 Metric watch，确认窗口已经开始后再依次执行各并发 Trial。
4. 每次请求记录 Case ID、Facet、首字节、首 token、完整响应耗时、协议事件和 OTel 关联键；错误率达到
   阈值时停止当前档，并同时形成总体、`by_case` 与 `by_facet` 统计。
5. 负载结束后封口 Metric 报告，从各 Trial 选择慢请求/错误请求的关联 ID，复用 Trace 与 Log 采集。
6. Perf 与它触发的 Metric/Trace/Log 分别向共享 Context 注册 Artifacts；统一 Delivery 汇总 HTML，并在
   `--format bundle` 时把完整目录一次性压成 `.tar.gz`。Perf 目录保留 `run.json`、`outcomes.jsonl` 和
   `verdict.json` 等 Harness 契约产物。

Trace/Log 的部分采集失败不会抹掉负载与 Metric 事实；综合报告必须显示具体缺口。Metric 窗口无法开始时
则不发起业务负载，避免得到无法解释的压测数据。
