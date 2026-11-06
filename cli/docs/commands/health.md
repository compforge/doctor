# Health

`doctor health` 以 Service 为单位主动巡检，发现服务未启动、Endpoint 未联通等明显问题。
Health 的整体模型按三个层级展开：服务自身健康、能够访问依赖、依赖协作后的功能正常。

## 三个健康层级

| 层级 | 要回答的问题 | 检查对象 | 常用机制 |
|---|---|---|---|
| 自身健康（`self`） | 服务自身是否存在异常？ | Service 声明的自身健康条件；当前已有检查主要覆盖启动、初始化与就绪状态 | Probe |
| 依赖连通（`deps`） | 服务启动后，能否访问当前需要的依赖？ | DataSource 与 downstream Service 的实际入口，包括地址解析、网络连接及所需协议的基本访问条件 | Probe |
| 功能可用（`biz`） | 具备连通条件后，服务及依赖协作提供的功能是否正常？ | 有明确预期结果的功能操作，例如文件下载、查询或一次业务请求 | 通常由 Case Run 承接 |

三个层级逐步深入：self 检查服务自身状态；deps 从消费方检查 Endpoint 的地址解析、网络连接和协议访问；
biz 验证具体功能操作的结果，例如下载并读取文件。

每个 Service 拥有自己的健康条件。DataSource 表达服务使用的数据源，downstream Service 表达它调用的服务；
两者都属于依赖层，不能因为依赖对象自身健康就推断消费方能够访问它。
依赖检查必须从消费方实际运行的 Pod、Container 或沙箱出发，并保留具体执行位置。
服务声明与运行配置、可选业务上下文共同决定本次适用的依赖；可选依赖未启用时不应作为故障，
依赖解析失败则需要保留为未知或覆盖缺口。

这也是排查时的递进顺序：先看服务自身是否异常，再看失败功能所需的依赖能否访问，最后判断功能结果。
启动依赖也可能在第一层就暴露问题，例如数据库配置错误导致初始化失败；同一问题可以分别保留启动现象与依赖侧证据。
逻辑上的递进不要求把三层绑定成一个不可拆分的流程，也不要求下层失败就丢弃其它层的证据。
Health 可以按需执行自身和依赖探测，基础检查无需先构造业务 Case。

Health 负责选择和启动 Probe、Case Run，并汇总结果；Service/Plugin 负责声明自身条件、适用依赖及功能预期。
Case 是承接功能验证的常用方式，Health 的范围同时包含独立的自身健康与依赖 Probe。
每层结果都应保留检查范围、实例、时间、证据和覆盖缺口，区分已验证通过、已验证失败与无法验证。
查询失败、工具缺失、没有适用实例或未执行的检查都不能当作通过。

历史错误、诊断和耗时统计由 [Overview](overview.md) 展示，用于回顾系统运行情况并按需选取代表样本。
Health 专注本次主动巡检，适用于部署后、接流量前及运行中的复查。

## 使用

```bash
doctor health
doctor health --service example-worker
doctor health --scope self,deps --service example-worker
doctor health -s example-api -s example-worker --tenant-id <tenant-id>
```

未指定 Service 时，交互模式展示服务多选列表，默认全选；非交互模式检查全部支持体检的 Service。
显式 `-s/--service` 跳过选择，只检查指定服务，支持别名并按规范名去重。
候选包括声明了受支持 DataSource、数据源依赖或 `endpoints` 的 Service，以及在自身精确 namespace 下提供
`health.case.bindings`、已标注 Health 层级的 `workload.probe` 或 `endpoint.probe` 的 Service。
显式 `endpoints: []` 也进入候选列表，表示没有对外 Endpoint 依赖。不查询 Plugin 产品 namespace。未声明体检能力的服务不进入默认列表，
显式选择时报告不支持。仅提供 Case 的服务由消费方引用执行。
选择取消时不连接目标环境；默认全选并不批准非只读请求，执行前仍走统一确认。

交互模式按 `self → deps → biz` 逐层执行所选服务，完成一层后展示结果，再询问是否继续下一层。
只对本次所选范围内有可用能力的层级执行和询问；拒绝或取消继续时，报告保留已完成的证据并标出未执行层级。
进入 `biz` 后才解析消费关系并补齐租户和用户，继续层级的确认不代替非只读 Case 的操作授权。
非交互模式及 `-y/--yes` 不询问，按 `--scope` 指定范围执行。

体检结果默认交付 HTML 和 Bundle，支持 `--format` 与 `--output`。
报告保存本次检查结果、覆盖缺口和有界探测响应，不进入业务 data/trace/log 采集流程。
如需从错误等现象定位具体对象，使用 [Overview](overview.md) 查询 biz-ids，再决定是否采集。

## 代码组织

`health/self/` 负责服务自身健康检查，`health/deps/` 负责数据源及下游依赖检查，`health/biz/` 负责 Case 准备、身份与执行授权、请求检查。
顶层 `flow.ts` 负责按层级推进与证据检查点，`index.ts` 装配命令、交互及共享资源；各层 `probes.ts` 准备相应 Probe 输入，依赖层同时解析和校验下游关系；`probe-runner.ts` 与 `runtime.ts` 提供跨层复用的探测执行和 Plugin 调用机制，`report.ts` 汇总展示结果。

## 探测接入与下游关系

`--scope` 支持 `self`、`deps`、`biz` 的逗号组合，默认 `all`。
`self` 检查服务自身健康，`deps` 检查数据源和下游依赖，`biz` 执行业务 Case。
未选择 `biz` 时不准备 Case 身份或执行 Case。所有检查保留本次执行时间，Health 不接收 `--since` 或询问统计窗口。所选服务没有对应能力时明确报告不支持。

`workload.probe` 通过可选的 `health: "self" | "deps"` 加入 Health；未标注的 Probe 保持 Collect 行为。
Core 按声明的 Workload 定位实例，每个 Probe 仅选第 1 个实例调用一次，不过滤未就绪实例。
结果保留实际探测实例和检查结果。
结果保留 Observation 和 Detector Finding，`status: "ok"` 表示取得证据，不能代替健康结论。
访问失败、工具缺失、空实例和取消都不能算健康；终端、HTML 与 diagnosis.json 保留相应原因。

`service.downstreams` 按可选 `bizId` 和消费方 `instance` 返回当前适用的关系：
`{ id, service, workload, endpoint: { host, port, tls? } }`。
目标 Service 和消费方 Workload 必须已声明；endpoint 不包含凭据或签名 URL。
成功返回空列表表示无适用依赖，查询或配置失败必须抛错。`--biz-id` 透传给提供方，具体筛选规则归提供方。
Core 在每个依赖 Probe 前解析关系，并通过 `input.health.downstreams` 交给 Probe；该机制不引入全局缓存。

网络探测机制属于 Toolbox `network`；Plugin 选择消费方执行位置并解释业务配置。
从 Host 访问成功不能代替 Pod/沙箱连通，DNS/TCP/TLS 成功也不能证明应用下载策略、HTTP 认证或对象权限通过。

## 消费方 HTTP Case 检查

Service 通过 `health.case.bindings` Extension 返回消费关系，表示它必须从自身 Workload 访问某个提供方产生的地址。
例如文件服务提供下载请求，消费方的容器必须能够访问该 URL；Doctor Host 的访问结果不能代替这一关系。
指定 Service 的 Health 在 `biz` 层执行这些检查。GET/HEAD 自动执行；
非只读方法在首次请求前统一确认一次，提示列出本轮消费方 Workload、Case 来源及执行上限。
决定通过 `CommandContext.decide()` 按准备好的检查范围保存，本轮跨服务、实例和 Case 复用同意或拒绝；
拒绝后跳过后续非只读请求，GET/HEAD 继续执行。下一次命令重新确认，非交互可通过全局 `-y/--yes` 预先批准。
Service 可以只提供 `health.case.bindings`。

Binding 以 `producer.service + producer.source` 定位 Service 的 Case 来源，
以 `workload` 引用消费方已声明的 Workload。消费扩展与来源的 `produce` 均遵循调用契约：声明 `access`，
通过 `run(context, input)` 返回 `{ data, summary }`。消费方返回 `{ bindings }`，提供方返回 `{ cases }`；
两次调用各自使用所属 Service 的 PluginContext、access 与租户条件。提供方
返回本次准备好的 HTTP Case 列表，每项由 canonical `case`、可选的业务对象 `subject` 与有序运行时 `targets` 组成；不执行请求。
同一来源的 `load` 提供离线定义，`produce` 绑定本次对象；签名 URL 不进入静态目录或配置。
探测哪些业务对象由 producer 决定，例如模型/Agent 提供方选取模型与 Agent，文件提供方选取下载文件。
Health 不选择这些业务对象，只补齐声明需要的上下文，控制执行预算、审批和结果汇总。

Health 在进入 `biz` 层级后调用消费方扩展取得本次关系、解析实际依赖的 producer，并补齐其声明的请求身份。
随后消费准备好的绑定与身份，解析消费方实例并确认 curl/exec 可用，再为每个实例获取新鲜 Cases，直接从消费方容器执行。
每个绑定最多检查 10 个 Running 实例，每个实例最多 10 个 Cases；提供方应在数据源处限制结果，
超限或提供方截断在报告中明确展示。实例未配置 container 且存在多个容器时报告缺口，不猜测业务容器。
请求沿用 HTTP Collect 的超时和响应容量预算，串行执行；代理与 TLS 使用目标容器 curl 的正常行为，
不绕过代理、不跳过证书验证、不回退到 Host/port-forward。重定向响应直接作为证据，不隐式跟随到另一目标。

GET/HEAD Case 可给出有序备用 URL，主地址不满足预期时继续尝试，遇到成功停止；原地址失败始终保留，
备用成功不把绑定改判为通过。每次尝试记录提供方、binding、Case、Pod UID/container、请求 URL（查询值脱敏）、
时间、HTTP/transport 结果与 Finding，headers/body/error 附件随 Health Bundle 交付。凭据头与已知签名值脱敏。
二进制文件保留受预算限制的响应内容；响应摘要对应下载流，文本附件可能经脱敏。

无法取得消费关系、无法准备 Pod、无法取得 Case、空 Case 列表和请求失败分别记录阶段和原因；它们不是网络成功。
单个消费扩展或绑定失败不丢失其他结果；证据同时保留消费扩展 ID 与 binding ID，取消保留已完成的尝试。Case 时间是本次执行时间。`doctor case` 的现有目录与发送入口保持独立。

消费方声明示例（提供方已在其 Service.cases 贡献 `file-downloads`）：

```ts
const worker = {
  ...workerService,
  extensions: [{
    id: "downloads", kind: "health.case.bindings", access: {},
    run: withSummary({ title: "文件消费关系", fields: [] }, async () => ({
      bindings: [{
        id: "file-download", workload: "main",
        producer: { service: "files", source: "file-downloads" },
      }],
    })),
  }],
};
```

Case 来源的 `produce` 返回 `data.cases`，将稳定意图与本次可访问的地址对应：

```ts
{
  case: {
    id: "file_download", desc: "文件可下载",
    input: { protocol: "http", method: "GET", headers: { Range: "bytes=0-1023" } },
    judge: { e2e: { http: { status: [200, 206] } } },
  },
  targets: [{ id: "primary", url: signedURL }, { id: "internal", url: internalURL }],
}
```

Case 使用 spec-case 的共享 HTTP profile；`case.input.protocol` 决定执行协议，`http` 同时支持目标 URL
中的 HTTP/HTTPS scheme。签名 URL 和各入口独立的认证头属于 targets，不改变 Case hash；实际 Pod 属于消费关系。
Doctor 在消费方 Pod 内发送请求，复用 HTTP Collect 的响应采集与 Detector，负责权限、备用入口策略与报告。
每项至少提供一个地址、最多五个，按声明顺序尝试；headers 只应用于所属地址，不跨备用入口继承。
Health 要求明确的 `judge.e2e.http`。GET/HEAD 不接受 body；非只读请求必须只有一个 target，
避免备用入口导致业务动作重放。`case.input.body` 是稳定请求正文；`target.body` 可提供本次解析后的完整正文
（如新会话 ID、授权上下文），覆盖稳定正文但不改变 Case hash，报告不保存请求正文。
无可用样本返回 `{ cases: [], reason: "当前租户没有可用文件" }`。消费关系为空表示本次没有适用检查，
不能作为网络连通性证据。非空 Cases 同时带 `reason` 表示部分准备失败；可运行的检查仍执行，
报告保留缺口，不能把剩余检查通过当作完整通过。


### Case 请求身份

需要真实租户/用户的 `produce` 可声明 `requestIdentity: { configured(config) }`，
复用 `ServiceCaseIdentityRequirement`；Plugin 解释自己的配置，Core 只消费返回的 tenantId/userId。
Health 在进入 `biz` 后按显式 `--tenant-id` / `--user-id`、Plugin 配置的优先级补齐身份。
缺失时通过 `tenant.list`、`user.search` 选择启用租户及该租户中的真实用户；同一身份只询问一次。
显式切换租户时不沿用原配置租户的用户，需重新选择或提供 `--user-id`。

身份通过 `CaseProduceQuery.requestIdentity` 传入，不修改 profile，也不写入报告。
Case 身份的租户只用于相应来源的本次请求，不写入用户未显式选择的整轮租户条件。
非交互（包括 `-y`）缺参时，相关绑定记录为 identity 阶段 unavailable，不进入 Pod 或调用 producer；
取消身份选择记录为 cancelled，其余独立检查继续。选择身份不是批准真实请求，非只读 Case 仍需审批。
签名 URL 与独立会话仍由 producer 在每个实例执行前生成，避免准备阶段产生的临时数据过期。

仅需要租户的 producer 声明 `requestTenant: { configured(config) }`，返回配置中的租户 ID 或 undefined，
不声明 `requestIdentity`。Health 复用相同的租户选择，按 CLI 参数、Plugin 配置、交互选择的顺序准备
`CaseProduceQuery.requestTenantId`，不查询用户。缺参或取消遵循同样的 identity 阶段处理。

### 模型功能探测

模型来源的 `load` 可以贡献 SDK 的 `MODEL_CONNECTIVITY_CASE_SET`。producer 自行查询模型目录，决定探测的模型 ID，使用 `modelHttpCases(model)` 将同一份用例
绑定到本次 inference 地址与模型。提供方负责遵守 `maxCases`，并显式报告截断或部分准备失败。
请求从消费方 Pod 发起；经过模型网关的调用验证整条业务链路，不把网关侧的供应商 DNS 解析归因于消费方。

共享用例覆盖基础调用、连续 assistant、连续 user，以及声明支持图片的 LLM、embedding 与 rerank。
`judge.e2e.model: { type: "llm" | "embedding" | "rerank" }` 配合 JSON HTTP 预期，检查响应能够解析、
没有错误包且包含有效 completion、向量或排序结果；不评价回答质量。HTTP 200 的空结果或错误包不算通过。
模型 ID 与展示名称放在运行时 subject，路由与推理模型标识放在 target，不写入稳定 Case 正文；响应仍受统一超时和容量约束。

Health 只做有界功能探测；Perf 测量所选 Case 的性能，Model 提供模型列表与模型吞吐测试。
三个入口可以复用用例内容，但不共享命令职责或运行策略。

### 流式响应与故障分类

SSE Case 在 canonical `judge.e2e.sse` 声明协议事件要求，由 Doctor 消费：

```ts
sse: {
  eventField: "type", terminalEvent: "END",
  requiredEvents: ["MESSAGE", "OUTPUT"], // 至少出现其中一种回复事件
  errorEvents: ["ERROR", "INPUT_REQUIRED"],
}
```

同时将 `judge.e2e.http.contentType` 设为 `text/event-stream`。只有 HTTP 状态符合预期、响应完整、出现回复事件与结束事件、没有错误事件时才通过。事件名属于提供方；Core 不包含业务 Agent 协议。
该检查验证协议执行，不评价答案内容；原始 SSE 及有界错误详情进入报告。

Case 报告根据本次 Pod 请求的退出码、错误文本与响应分类 DNS、代理 DNS、连接、超时、TLS 证书、TLS 握手和 HTTP 状态错误。`wrong version number` 等证据只给出“疑似 HTTP 配成 HTTPS”，因为代理或 TLS 配置也可能产生相同错误；服务端明确返回“HTTP 发到了 HTTPS 端口”则记录该响应事实。
报告保留目标 URL 的 scheme/端口、Pod/container、对端 IP、阶段耗时及原始错误；不自动切换 scheme、跳过证书校验或把备用成功覆盖原始失败。旧 curl 没有阶段耗时，也保留退出码和 stderr。

## 数据源健康

Service 自身的 OpenSearch VDB DataSource，以及 `dependencies` 显式引用的 OpenSearch DataSource，
由 Core builtin `datasource.health` 探测；不要求额外注册 Service Extension 或把集群检查包装成 Case。
Health 按声明的来源准备访问，失败时保留来源与错误，不替换成其它集群。相同来源在本次命令中复用准备和探测结果。

检查包括集群状态、节点剩余空间、实时 low/high/flood-stage 水位、主副分片和索引写入限制。
越过 low 水位就给出预警；读取水位失败时注明默认值与较低置信度。报告中标明本次探测时间，
当前容量证据仅描述本次探测时的状态。采集完整性与健康 Finding 分别报告。

### 对外 Endpoint 依赖

Plugin Service 通过 `endpoints?: readonly Endpoint[]` 直接声明对外访问依赖。
`Endpoint` 从 `@compforge/harness-common` 导入，包含地址字段及可选 `id`、`description`、`workload`。
`workload` 携带消费方完整 Workload 声明（platform、location、namespace、container），Doctor 直接据此定位探测实例，
不再按 name 查询 Service.workloads；缺少该字段时保留未知覆盖，不猜测执行位置。
URL 解析可复用 Toolbox 的 `endpointFromUrl`。

未声明表示未提供依赖信息；显式 `[]` 表示没有对外 Endpoint 依赖，不发现实例或执行网络请求。
仅声明 Endpoint 的 Service 也进入 Health 候选列表。声明直接提供地址，不包含 resolve operation。

Core 在 deps 层从消费方 Kubernetes Container 执行通用 connectivity，并声明 pods/exec 权限。
每次探测限时 5 秒，每个 Service 最多 100 个地址；每个地址仅从其 Workload 的第 1 个 Running 实例探测一次。
保留实际探测实例与检查结果。超出地址上限的部分逐项记录为
`not-run` 并注明上限原因，不作为 unavailable 取证失败。已执行项全部通过时，覆盖不完整的结果仍为 partial。
同一 Workload 的实例发现结果在本轮检查内复用。目标地址按原样探测，不根据 DNS namespace 推断服务关系。
网络失败保留阶段证据；工具缺失、无法定位实例及不支持的加密协议保留 unavailable 和错误 kind/code。
终端、HTML 与 diagnosis.json 展示 Endpoint 结果；它们只证明 DNS/TCP/受支持 TLS 的连通性。

### Probe 取消语义

取消信号通过 PluginContext.signal 传递给 Probe 及其访问操作。Probe 应将该信号传给底层请求，
并在耗时计算中主动检查；Host 不会强行终止不响应信号的 Plugin 代码。
未开始的 Probe 记录为 `not-run`（未执行），执行中响应取消的 Probe 记录为 `cancelled`（已取消），
已经完成的 Probe 保留原结果；一个 Probe 已取得的部分 Observation 也保留。
层级中途取消时，报告逐项展示未执行的 Probe，`notRunScopes` 仅列尚未进入的后续层级。
尚未开始的通用 Endpoint 同样逐项记录为 `not-run`，包括当前 Service 和后续 Service 的声明；
停止后的记录补齐不发现实例、不执行网络请求，也不覆盖已经取得的结果。

### Plugin 自定义 Endpoint 探测

Service 对每个依赖二选一：贡献 `service.endpoints` 使用 Core 通用探测，或贡献 `endpoint.probe`
Extension 实现个性化探测。避免对同一依赖重复贡献是 Plugin 的责任。
Core 独立执行收到的两类贡献，不匹配地址或 id，不覆盖、不去重，也不在自定义探测失败后回退。

`defineEndpointProbeExtension` 声明 `id`、`kind: "endpoint.probe"`、完整消费方 `workload`、
`access`、`produces` 和 `run(context, { instance })`。Extension 自己掌握目标地址和访问方法；
可以不声明任何 `service.endpoints`，也无需在 `Service.workloads` 再登记该 Workload 名称。
Core 在 deps 层为声明的 Workload 选第 1 个实例，调用一次 Probe，复用权限、客户端生命周期、取消、Value codec、Observation 和 Detector。
返回 `WorkloadProbeResult`（`ok`、`partial` 或 `unavailable` 与 Value）；这表示取证状态，健康判断保留在 Observation/Findings。

通用 exec 探测仅选第 1 个 Running 实例，不为未选副本重复执行或生成失败记录。
没有可执行实例时 Endpoint 标为 unavailable；自定义 Probe 的可执行条件由 Plugin 判断。
