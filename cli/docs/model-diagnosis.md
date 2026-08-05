# Model 诊断

## 理念 / 概念

`doctor model` 用一条确定性链路检查模型目录配置并发起真实 inference，帮助区分“租户看不到模型”“backend 数据不完整”“validation 失败”和“validation 通过但推理协议失败”。

- **可用模型**：从 Plugin 声明的 `modelCatalog` capability 按租户读取，代表该租户当前能选择的模型。
- **Backend handle**：由模型目录返回，向 Core 暴露规范化身份和 validation 行为；原始路由、provider 参数与凭据只由 Plugin 实现持有。
- **Inference 模型**：使用可用模型返回的规范化 `baseUrl` 与 `model` 目标，向 Plugin 声明的 `inference` capability 发出最小请求。
- **轻量性能采样**：LLM validation 通过后可选执行的串行流式真实请求；从短、中、长输入观察 prefill/TTFT，再用持续生成场景观察 decode。它用于低成本发现明显异常，不模拟并发负载，也不代表模型容量。
- **专业性能压测**：后续由 [AIPerf](https://github.com/ai-dynamo/aiperf) 承担负载调度、数据集生成和专业指标统计；Doctor 负责解析 Plugin 提供的模型目标与访问上下文、显式授权执行，并把结果收进诊断报告。
- **Facts / Observations / Findings**：模型身份与脱敏 backend 摘要是 Inspect Facts；validation、inference 响应和性能样本是 Probe Observations；失败、usage 缺失和间歇性异常由纯 Detector 从 Evidence 推导。

交互终端中，缺少 tenant 或 model 参数时分别从 `tenantDirectory` 和 `modelCatalog` capability 提供的候选中选择；LLM validation 通过后会展示请求规模并询问是否执行性能采样。非交互环境必须显式提供 `--tenant-id` / `--tenant-name` 与 `--model`，且只有 `--performance` 才会发起多轮性能请求。

## 流程

1. 解析 profile、namespace 与 Kubernetes 连接信息。
2. 从 Plugin 声明的租户目录解析或交互选择 tenant。
3. 从 `modelCatalog` capability 获取可用模型，并解析或交互选择目标 model。
4. Model Inspect 从模型目录取得同一模型的 backend handle，生成目标与脱敏 backend Facts；原始配置和 credentials 留在 Plugin 闭包内。
5. Validation Probe 调用 backend handle 的 validation 行为并形成 Observation；Core 不解释 provider 私有字段或拼接 validation payload。
6. validation 成功后，Performance Decision Probe 处理显式参数或交互选择；选择性能测试时 Inference Probe 标记为 unnecessary，否则执行最小 inference。
7. Performance Probe 串行执行短、中、长输入和持续生成场景，每次真实响应形成独立 Observation；它不产生并发或目标 RPS。
8. Model Detector 只读取 Facts 与 Observations，计算性能指标、coverage 和 Findings；Renderer 再交付 HTML 报告。embedding / rerank 保持非流式最小请求。

## 关键设计

### validation 与 inference 分开

模型 validation 只证明 backend 配置能被 inference service 接受，不能证明租户实际拿到的 `baseUrl + model` 能完成推理。两步分开输出，故障边界更清楚。

### 模型目录是配置事实源

Doctor 不自行拼接凭据或 provider 参数。可用模型与 backend 都从 `modelCatalog` capability 读取；Core 只持有脱敏 backend 身份和可调用 handle，凭据始终留在 Plugin 实现内，不进入公共 SDK 数据结构、终端或落盘证据。

### Inspect、Probe 与 Detector 保持硬边界

Inspect 只读取目标现状并生成可持久化 Facts；Probe 才能访问 `modelCatalog` / `inference` capability、执行交互和真实推理；Detector 是 `Evidence => Finding[]` 的纯函数，拿不到 capability client 或 Kubernetes executor。性能指标从 Observation 离线推导，因此同一证据可被报告、规则或后续分析重复消费。

### 输入长度与输出长度分开观测

Prompt 长度主要影响 prefill 和 TTFT，输出长度主要影响 decode 吞吐。标准套件用三档输入配短输出观察 TTFT 随上下文增长的变化，再用短输入配持续输出观察 TPOT 与单用户 output TPS，避免用一次短问短答同时推断两种性能。不同模型 tokenizer 不同，报告以响应 usage 的 `prompt_tokens` 为准；usage 缺失时只保留字符规模和 chars/s，不把估算值伪装成 token 指标。

### 轻量采样的指标口径

网络 `ReadableStream` chunk、SSE event 和模型 token 是三个不同层次：网络 chunk 可以包含半个或多个 SSE event，一个 SSE event 也可能包含多个 token。Doctor 先按 SSE framing 还原 event，再解释 OpenAI delta；普通 chunk 间隔不能命名为 TPOT。

- TTFT 从请求开始算到首个非空语义 delta；推理模型另记首个非 reasoning 可见输出 TTFO。
- ICL 是相邻非空语义 SSE event 的到达间隔，用于观察网络抖动、buffering 和用户感知卡顿。
- 平均 TPOT 使用首尾有效输出到达间隔除以 `completion_tokens - 1`；单用户 output TPS 是 TPOT 的倒数。usage 缺失、实际输出不足两个 token 或没有有效生成区间时不输出 token 指标。
- `max_completion_tokens` 只是输出上限，报告必须同时展示实际 `completion_tokens` 与 `finish_reason`，不能把过早停止的短输出当成持续 decode 样本。

当前串行采样保持小范围：各场景先执行一次不计入结果的 warmup，重复轮次使用可复现但不同的 prompt 以避免意外命中 prefix cache，并明确记录实际 ISL/OSL。少量样本只展示逐次值、中位数和范围，用来发现明显回归；不把它包装成负载下的 p95/p99 或容量结论。

### AIPerf 专业压测

AIPerf 是面向生成式模型服务的独立压测引擎，原生支持 OpenAI Chat 兼容端点、并发或目标 request rate、warmup、合成数据集与 trace replay，并区分 TTFT、TTFO、ITL/TPOT、ICL、请求吞吐和输出 token 吞吐。它与轻量采样回答不同问题：

- 轻量采样回答“单请求路径是否存在明显的 prefill、decode 或流式交付异常”。
- AIPerf 回答“在指定 workload、RPS 与并发上限下，延迟分位数、错误率、吞吐和满足 SLO 的 goodput 是多少”。

后续接入时，Doctor 不复制 AIPerf 的调度与指标实现。Doctor 负责租户/模型发现、Model Gateway 访问准备、凭据与脱敏边界、执行预算确认及报告归档；AIPerf 作为外部进程负责 benchmark，并以 JSON/CSV artifact 交付结果。专业压测有实际流量和模型成本，应使用 `doctor model` 下显式的 perf 模式，不能由默认 collect 或普通 validation 隐式触发。

### SSE 共享边界

SSE framing、frame 到达时间、间隔与 `[DONE]` 终态属于通用 HTTP 观测，位于 `collect/shared/http`，供 `doctor model` 与 `doctor http` 共用。OpenAI `delta`、reasoning、tool call、finish reason 和 usage 属于模型协议，只在 Model collect 中解释。

### terminal 只拥有交互机制

租户查询、分页与“当前启用”语义由 Service 的 `tenantDirectory` capability 提供，模型候选由 `modelCatalog` capability 提供，选择语义留在 Model collect；可复用的租户列表渲染、关键词搜索和序号确认位于 `terminal/`，供其它 collect command 共用。

### 当前范围

Inference 覆盖 `llm`、`embedding` 与 `rerank`；轻量流式性能采样和后续 AIPerf 专业压测都只覆盖 `llm`。当前采样保持串行，是主动观测而不是并发压测。`audio` 的请求形状依赖具体能力，当前会明确提示不支持，不构造猜测性的探测请求。
