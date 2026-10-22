# doctor perf 主动性能诊断

## 理念 / 概念

`doctor perf` 回答“逐档提升并发时，普通业务请求从哪一档开始变慢，慢在哪里”。交互运行会让用户从
1、5、10、20、50 中选择最高并发，默认 20；自动化运行可通过 `--levels` 显式指定不超过 50 的档位。
Perf 是带自身加压动作的组合工作流：它拥有负载执行和 Perf Artifact，同时触发 Metric、代表请求的 Trace
和 Log；这些产物最终由统一 Delivery 一起交付。

Perf 是与 Provision、Collect、Eval、Chat 平级的顶层工作流。它会产生真实业务数据、Trace 和可能的模型费用，
因此执行前必须展示发压时长、并发档位、无请求总数上限及熔断条件和影响并取得确认。

## 职责边界

- 语言中立的 Perf Harness 契约定义 Case、Arm、ArmRun、Stage、Window、Outcome 和落盘 IR；Python 与
  TypeScript 是两个平级实现，互不作为对方的规范。
- Doctor Core 使用 TypeScript 实现调度负载、控制并发和时长、按 dispatch 时间归窗，并写出
  `run.json` / `requests.jsonl` / `evaluations.json`。
- `Service.cases` 的同一来源提供 spec-case canonical CaseSet 和并发安全的单请求 runner；
  `perf.scenarios` Extension 返回观测预设，显式引用 `cases: { service, source }`，并包含关联键优先级和可观测 Service 清单。Case 从所引用来源的共享目录选择，
  单选时始终执行该 Case，多选时由 Harness 等权随机抽取。Case
  不携带环境、凭据、并发度或权重。
- CaseSet 用受控 Facet 词表声明 `difficulty`、`task_type` 等分类轴；Case 只选择每个轴上的值。
  spec-case 统一校验完整资产，Perf Harness 按 Facet 归约性能数据，避免用自由字符串形成不可维护的报告维度。
- HTTP/SSE 私有字段、鉴权、连接复用和首 token 语义留在 Plugin runner，Core 不认识某个产品的 Chat
  body、身份 header 或业务 ID 语义。
- Case 需要租户/用户身份时，由 Plugin 声明目录 Service 并读取自身 profile 配置；Core 复用
  `tenantDirectory` 补齐缺失的租户和用户选择。用户目录按关键词和页码查询，Plugin 必须在业务目录侧
  执行筛选与分页，不能先聚合全量用户；IAM 等私有查询协议仍留在 Plugin。
- “如何加压”分成两个所有者：Core 决定何时 dispatch、并发多少、何时停止；每个 dispatch 如何变成一笔
  真实业务请求由 Plugin runner 决定。Runner 可以在 ArmRun 生命周期内 setup/cleanup，但不能自行启动隐藏
  的请求循环，否则 Core 无法执行预算、熔断和 Window 归属。
- `doctor metric`、`doctor trace`、`doctor log` 仍分别拥有三个可观测数据面的采集与报告；Perf 只负责
  统一窗口，并把 Plugin 声明的业务 ID 交给既有 `traceId` resolver 做关联。

## 流程

1. 选择提供 `perf.scenarios` 的 Service 与观测预设，解析其引用的 Case 来源，再选择 runner 支持的一个或多个 Case。来源可以属于另一 Service，runner 使用该来源的访问上下文。当前目录的 `doctor-cases.yaml` 也可提供兼容 CaseSet；`--caseset` / `--cases` 支持非交互选择。
2. 交互运行选择最高并发；按需从 Plugin 声明的目录选择租户，再通过服务端关键词搜索和分页选择用户；
   随后展示并确认并发档位、每档发压时长、无请求总数上限、错误率熔断和持久数据影响。非交互运行默认使用
   5、10、15、20 四档，并必须由 Plugin profile 提供身份。
3. 先启动 Metric watch，确认窗口已经开始后再依次执行各并发 ArmRun。
4. 每次请求记录 Case ID、Facet、首字节、首 token、完整响应耗时、协议事件和 OTel 关联键；错误率达到
   阈值时停止当前档，并同时形成总体、`by_case` 与 `by_facet` 统计。
5. 负载结束后封口 Metric 报告，从各 ArmRun 选择慢请求/错误请求的关联 ID，复用 Trace 与 Log 采集。
6. Perf 通过统一 CommandSpec 调用 Metric/Trace/Log，显式汇总每次调用的状态和 Artifacts；根 Finalize 调用 Perf renderer 组合子 Report，Delivery 生成离线 HTML，并在
   `--format bundle` 时把完整目录一次性压成 `.tar.gz`。Perf 目录保留 `run.json`、`requests.jsonl`、`evaluations.json` 和
   `verdict.json` 等 Harness 契约产物。

Trace/Log 的部分采集失败不会抹掉负载与 Metric 事实；综合报告必须显示具体缺口。Metric 窗口无法开始时
则不发起业务负载，避免得到无法解释的压测数据。

命令结果保留 Metric 和各代表请求的 Trace/Log 状态，部分证据失败时为 partial，用户取消时为 cancelled。
Metric 窗口正常封口只停止该采集窗口，不取消整轮 Perf；根取消信号则同时停止负载和正在执行的采集。

## Harness 0.1 接入

旧版 `--max-requests` 已移除；使用并发、ramp/hold 时长及错误率熔断控制负载。请求总数不设上限，
实际调用量取决于响应速度，执行确认会明确展示这一点。旧 CLI 参数或嵌入调用的 maxRequests 会报错，不静默忽略。

Doctor 使用 Runner 记录单次请求的 Outcome，独立 Judge 调用 Plugin 的协议分类；原始错误信息保留在
Outcome.meta，判定写入 evaluations。schema 6 的 Run.executions 保存 ArmRun，每笔请求通过
operation_run_id 关联 OperationRun。代表请求仅从已完成请求中选取，错误类型读取独立判定；被取消的
在途请求保留为 interrupted，不参加判定和延迟分布。

每档使用 request_rate=Infinity 的饱和加压，由 max_inflight 控制并发；显式 Stage 从 1 并发 ramp 到目标，
再 hold。measurement 只统计 hold 发出的请求，ramp 与 cooldown 分别保留，避免混入稳定负载指标。

Ctrl+C 由 Doctor 宿主转换为共享 AbortSignal，同时通知 Harness、请求资源上下文和 Metric 窗口。
Harness 立即停止新请求、取消在途请求并等待它们退出，再执行 cleanup；取消时跳过常规 cooldown 等待。
Plugin runner 必须响应 signal。正常结束仍使用 --graceful-stop 限制在途请求的收尾等待。
取消、Metric 收尾、资源清理、报告生成和 Bundle 保存会向 stderr 显示进度，不受日志级别过滤。
已取消的运行保留已采集证据并以 130 退出，不继续采集新的代表请求。
