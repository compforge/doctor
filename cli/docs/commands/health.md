# Health

`doctor health` 以 Service 为单位进行体检式主动巡检，用有限且有明确判定标准的检查，
提前发现基础设施不可用、服务未启动、依赖访问失败或业务功能异常等问题，起到预警作用。

检查通过，只表示本次检查范围、条件和时间点内未发现异常，不保证真实业务、其它输入或负载下没有问题。
检查不通过，应明确说明哪项条件不满足、观察到了什么证据及可能影响什么；证据不足时不推断唯一根因。
无法检查和用户跳过表示覆盖缺口，不能计作通过，也不能直接认定目标故障。
这一定位集中说明于本文；终端展示检查结果、实际执行位置与失败原因，不在每项结果后重复免责声明。

## 按 scope 递进

Service 各自贡献检查，Core 按 `infra → self → deps → biz` 执行：先完成所有 Service 的 infra，再进入 self，以此类推。
DataSource-backed Probe 按已解析的 `DataSource.id()`、scope、probe 版本、参数与批准风险在本轮复用结果。
同一数据库和访问身份只探测一次；数据库、凭据、环境或判定策略不同，仍分别执行。
各 Service 保留自己的结果，复用项记录 `dataSourceId` 与 `reusedFrom`，终端和 HTML 标明来源。
未声明 DataSource 的 Probe 按 Service 分别执行；Case 仍按消费方实例执行。

| scope | 查验内容 | Plugin 检查示例 |
|---|---|---|
| infra | 服务启动所需的基础条件 | DB 连接认证、Host S3 上传下载、OpenSearch 健康与容量 |
| self | 服务自身是否启动、就绪 | Container Ready、hictld Pillow 状态 |
| deps | 消费方能否访问运行所需的依赖 | Pod 到 UP 的连通性、模型请求 |
| biz | 特定业务操作能否成功 | Sandbox 文件/Skill 下载、Agent 请求 |

前层问题通常影响更广，可能使后层检查缺乏诊断价值；实际影响取决于依赖关系。
当前不根据失败结果自动阻断后层。用户可据已有证据跳过检查或结束巡检，也可单独选择某一层。
没有检查能力、证据不足或用户跳过都不能视为通过。
Host S3 成功不能替代 Sandbox 下载：后者验证实际消费位置及 egress 策略，属于 biz。

## 交互和报告

```bash
doctor health
doctor health --scope infra,self,deps
doctor health --scope deps -s example-worker
doctor health --scope biz -s example-worker --tenant-id <tenant-id>
```

交互时未传 scope，先多选层级，默认 infra/self/deps；取消选择不连接环境。
infra/self/deps 自动发现所选范围的显式检查，进入 biz 才选择 Service。`-s` 过滤整轮并跳过 biz Service 选择。
显式选择但未提供所选检查的 Service 报告不支持；未显式选择时不列入候选。

self 中只读 Probe 自动执行；其它 Probe 先显示描述、目标和影响，y 执行、n 跳过、q 结束，默认 n。
DataSource-backed Probe 先统一批准只读配置解析，再对每个唯一目标批准探测；跳过解析不会读取配置。
解析只确定身份，不建立目标客户端；复用已有结果不重复询问。其它 Probe 的批准仍在配置读取前。
S3 的上传、预签名下载、内容校验与清理只批准一次；已上传对象的清理不再次询问。
Case 按实际消费方实例和请求逐项批准；租户/用户准备与批准请求分开，身份仅在所属 scope 执行时准备。
非交互不询问 scope，默认 all；只读操作自动执行，写操作需要 `-y`，缺少批准记为未执行。

终端、HTML 和 Bundle 保存每个检查的 scope、时间、结果、摘要及有界证据。
结果区分 passed、failed、partial、unavailable、skipped、not-run、cancelled。
单项失败不终止其它独立检查；退出或取消保留已完成证据，尚未开始的检查不会读取配置或访问目标。
`--pod/--container` 是传给 Plugin 的实例选择条件，具体适用范围由检查实现决定。
Health 不接收历史窗口；历史问题和统计由 [Overview](overview.md) 提供。

## 检查契约与归属

Service 在 `extensions` 中声明 `healthcheck.infra/self/deps/biz`，kind 是唯一的 scope 来源。
Core 不从 DataSource、dependencies、endpoints 或 Collect 的 workload.probe 隐式生成检查。
旧的 `health.case.bindings`、`endpoint.probe` 和 `workload.probe.health` 已移除。

检查有两种执行方式：

- `execution: "probe"`：Plugin 直接执行检查，返回 `HealthProbeResult`（status、summary、可选 evidence）；必须声明 approval 的 risk、target、impact。
- `execution: "cases"`：Plugin 返回消费关系 bindings，Core 复用共享 Case 引擎完成身份准备、逐请求批准、执行和判定。

```ts
const models: HealthCaseExtension = {
  id: "model-requests", kind: "healthcheck.deps", execution: "cases",
  description: "从消费方检查模型访问", access: {},
  run: withSummary({ title: "模型消费关系", fields: [] }, async () => ({
    bindings: [{ id: "models", workload: "main",
      producer: { service: "model-provider", source: "models" } }],
  })),
};
```

Core 只拥有发现、scope 调度、交互批准、取消、Case 执行与报告。
Plugin 拥有检查定义、目标和配置、实例采样、执行位置、适用条件与健康判定。
Toolbox 提供 DB/S3/Workload/网络等可复用机制，不认识 Doctor scope 或业务 Service。
采集 Probe 与 HealthCheck 的契约独立；可以共享底层函数，不通过继承或双重登记混用执行语义。

DataSource 直接使用 Harness Common 0.8 的 Identity 契约；客户端配置仍由 `clientKey` 管理。
DataSource-backed Probe 提供 `dataSource(context, query)` 配置解析器、稳定的 `probe` 名称/版本，
以及覆盖输入和判定策略的 `parameters`。身份必须覆盖实际目标与访问上下文，不能包含明文凭据或 Service 别名。
Core 批准后提供 `input.client()`，由 Probe 在错误处理范围内借用已初始化客户端；
客户端在当前 Plugin 调用结束前释放，结果只在本轮保留，不跨运行缓存。
失败、证据不完整与用户跳过均保留原状态；取消、未执行和未返回有效结果的异常不进入复用缓存。

Probe 通过 `context.signal` 传播取消；用 `input.checkpoint(result)` 保存中间证据。
完整结果和每次检查点均要求 JSON 安全、无凭据且不超过 128 KiB；超限或无效结果不能算通过。
Plugin 自己遵守请求超时与采样预算，Core 不强制终止不响应信号的进程内代码。
S3 清理等必要收尾可使用独立期限，并在返回前记录结果。

代码入口：`health/extensions.ts` 发现声明，`flow.ts` 按 scope 调度，`index.ts` 装配命令与批准，
`cases/` 共享 Case 准备及执行，`report.ts` 交付通用检查结果。
Core 的 `datasource.health` 仍服务 Collect/Trace 证据诊断，不再自动成为 doctor health 的检查项。

## 消费方 HTTP Case 检查

Binding 以 `producer.service + producer.source` 定位 Service 的 Case 来源，
以 `workload` 引用消费方已声明的 Workload。消费扩展与来源的 `produce` 均遵循调用契约：声明 `access`，
通过 `run(context, input)` 返回 `{ data, summary }`。消费方返回 `{ bindings }`，提供方返回 `{ cases }`；
两次调用各自使用所属 Service 的 PluginContext、access 与租户条件。提供方
返回本次准备好的 HTTP Case 列表，每项由 canonical `case`、可选的业务对象 `subject` 与有序运行时 `targets` 组成；不执行请求。
同一来源的 `load` 提供离线定义，`produce` 绑定本次对象；签名 URL 不进入静态目录或配置。
探测哪些业务对象由 producer 决定，例如模型/Agent 提供方选取模型与 Agent，文件提供方选取下载文件。
Health 不选择这些业务对象，只补齐声明需要的上下文，控制执行预算、审批和结果汇总。

Health 在进入声明的 `deps` 或 `biz` 层级后调用消费方扩展取得本次关系、解析实际依赖的 producer，并补齐其声明的请求身份。
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
    id: "downloads", kind: "healthcheck.biz", execution: "cases",
    description: "从消费方验证文件下载", access: {},
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
Health 在进入该 Case 的 scope 后按显式 `--tenant-id` / `--user-id`、Plugin 配置的优先级补齐身份。
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

### 模型依赖探测

消费方用 `healthcheck.deps` 声明 `execution: "cases"`，引用模型来源；该检查随 deps 自动发现，不依赖 biz 的 Service 选择。
它沿用真实消费方实例与模型调用链路，只改变调度层级，不改成 Host 请求，也不放宽 POST 请求批准。

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
