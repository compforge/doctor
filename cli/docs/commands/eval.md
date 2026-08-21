# doctor eval 数据集采集

## 理念 / 概念

`doctor eval` 回答“按这个 CaseSet 真实执行后，发生了什么，相关证据在哪里”。它逐例触发选中的
canonical Case，每个 Case 只执行一次，并把 CaseSet 快照、协议 Observation 及关联的 Trace、Log、Data
交付为离线 HTML 和 Evidence Bundle。

这里的 Eval 是评估数据生产流程，不是回答质量评估器。CaseSet 可以携带 `judge.eval` 等供下游系统使用的
评估配置，Doctor 只原样保留，不解释、不执行，也不生成质量分数。需要 worksheet、judge、对照实验或榜单
时，由 case-harness 等评估系统消费这些数据。

## 职责边界

- Case 与 CaseSet 的 canonical schema、校验和版本化资产归 spec-case；Eval 不复制 schema，也不把环境、
  凭据或并发参数写回 Case。
- Service Case Capability 提供 CaseSet 和单次请求 runner，拥有具体 HTTP/SSE 协议、鉴权、业务身份和
  协议成功判定。Runner 的一次 `trigger` 必须对应一个 Case 请求，不能自行启动隐藏循环。
- Doctor Core 负责选择 CaseSet/Case、顺序调度、生命周期、确认真实请求影响，以及将 Observation 的业务
  关联 ID 交给既有 Trace、Log、Data Command。
- Trace、Log、Data 仍拥有各自的 capability、访问准备、Evidence 和报告；Eval 只组合稳定入口及产物，
  不复制第四套采集器。
- `doctor perf` 可以使用同一 CaseSet 和 runner，但拥有并发档位、请求预算、熔断、Window 与性能归约；
  `doctor eval` 不加压，也不产生性能结论。

## 流程与产物

1. 选择唯一的 Case provider 与 CaseSet；可用 `--cases` 选择子集，未指定时执行全部 Case。
2. 若 Case 声明需要请求身份，则从 Plugin profile 读取；交互运行可通过其声明的租户目录补齐。
3. 展示 Case 数量、目标 Service、真实业务写入和可能的模型费用，并在用户确认后开始执行。
4. 顺序触发每个 Case 一次，记录起止时间、Facet、完整协议 Observation、协议判定及首个可识别关联 ID。
5. 对去重后的关联 ID 调用现有 Trace、Log、Data 采集入口，并把所有 Artifact 交给统一 finalize。

Eval 自身目录至少包含：

- `caseset.json`：本次使用的完整 canonical CaseSet 快照；
- `observations.jsonl`：逐 Case 的协议 Observation、判定和关联 ID；
- `run.json`：运行身份、Case 结果及各关联数据面的采集状态；
- `report.html`：Case 执行与证据覆盖概览。

缺少关联 ID 或 Plugin 未声明某类可选 capability 时，该数据面标记为 `unavailable`，已取得的 Observation
仍然交付；已经选择并执行的采集器失败时标记为 `failed`，命令返回失败。默认同时生成外置 HTML 和完整
`.tar.gz`，也可通过 `--format html|bundle` 只选择一种交付。
