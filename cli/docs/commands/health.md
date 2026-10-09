# Health

`doctor health` 展示系统统计并执行所选 Service 的体检，不查找代表 biz-id，不触发 Collect。
统计复用 `overview.summarize` 与 `overview.cost`；主动探测使用 `case.consume/produce`。
Health 完整展示 summary，包括不可采样的状态条目；不要求对应的 sample Extension。
两类结果分别说明历史窗口内的情况和本次执行的情况，查询失败不等同于系统异常，也不丢弃其他已取得结果。

## 使用

```bash
doctor health
doctor health --since 1h --service example-worker
doctor health --services example-api,example-worker --tenant-id <tenant-id>
```

未指定 Service 时，交互模式展示服务多选列表，默认全选；非交互模式检查全部支持体检的 Service。
显式 `--service` 或 `--services` 跳过选择，只检查指定服务，支持别名并按规范名去重。
候选来自各 Service 精确 namespace 下的 `overview.summarize`、`overview.cost` 或 `case.consume`，
不查询 Plugin 产品 namespace；统计应注册到对应 Service 作用域。未声明体检能力的服务不进入默认列表，
显式选择时报告不支持。仅提供 Case 的服务由消费方引用执行。
选择取消时不连接目标环境；默认全选并不批准非只读请求，执行前仍走统一确认。

体检结果默认交付 HTML 和 Bundle，支持 `--format` 与 `--output`。
报告保存统计结果、覆盖缺口和有界探测响应，不进入业务 data/trace/log 采集流程。
如需从错误等现象定位具体对象，使用 [Sample](sample.md) 查询 biz-ids，再决定是否采集。

## 耗时统计

`overview.cost` 是独立 Extension，可与 `overview.summarize` 在同一 namespace 共存，也可单独提供。
Core 使用相同的冻结窗口和租户条件调用它，以提供该 Extension 的原始 Service 准备 access；
两类查询独立记录成功或失败，一项失败不丢弃另一项的结果。

Provider 接收 `OverviewCostQuery`（`maxEntries` 约束统计条目，`maxRecords` 约束源记录，当前为 1000），
返回 `OverviewCostResult`：description 说明样本总体、时间字段、区间与百分位算法，entries 以稳定 key、
label、sampleCount、missingCount 和 durationMs（min/avg/p50/p95/max）描述耗时。
单位固定为毫秒；没有有效样本时省略 durationMs，不能用零替代未知值。缺失、不完整或无效区间计入
missingCount。Provider 在源头限制读取，并说明截断；Core 校验统计数据并限制展示条目。

终端和 HTML 显示耗时表，diagnosis.json 保留类型化统计。耗时条目当前仅供查看，不进入
`overview.sample` 或自动触发 Collect。具体数据位置与统计口径由 Plugin 持有。

## 消费方 HTTP Case 检查

Service 通过 `case.consume` Extension 返回消费关系，表示它必须从自身 Workload 访问某个提供方产生的地址。
例如文件服务提供下载请求，消费方的容器必须能够访问该 URL；Doctor Host 的访问结果不能代替这一关系。
指定 Service 的 Health 在统计查询后执行这些检查。GET/HEAD 自动执行；
非只读方法在请求前使用统一操作确认，非交互可通过全局 `-y/--yes` 预先批准。
没有 summarize/cost 的 Service 也可以只提供 `case.consume`。

Binding 以 `producer.namespace + producer.extension` 定位 Service 的 `case.produce` Extension，
以 `workload` 引用消费方已声明的 Workload。两个 kind 均遵循普通 Extension 契约：声明 `access`，
通过 `run(context, input)` 返回 `{ data, summary }`。消费方返回 `{ bindings }`，提供方返回 `{ cases }`；
两次调用各自使用所属 Service 的 PluginContext、access 与租户条件。提供方
返回本次准备好的 HTTP Case 列表，每项由 canonical `case` 与有序运行时 `targets` 组成；不执行请求。
这个运行时接口独立于离线 `case.catalog`，签名 URL 不进入静态目录或配置。

Health 在 Command prepare 阶段调用消费方扩展取得本次关系、解析实际依赖的 producer，并补齐其声明的请求身份。
run 消费准备好的绑定与身份，解析消费方实例并确认 curl/exec 可用，再为每个实例获取新鲜 Cases，直接从消费方容器执行。
每个绑定最多检查 10 个 Running 实例，每个实例最多 10 个 Cases；提供方应在数据源处限制结果，
超限或提供方截断在报告中明确展示。实例未配置 container 且存在多个容器时报告缺口，不猜测业务容器。
请求沿用 HTTP Collect 的超时和响应容量预算，串行执行；代理与 TLS 使用目标容器 curl 的正常行为，
不绕过代理、不跳过证书验证、不回退到 Host/port-forward。重定向响应直接作为证据，不隐式跟随到另一目标。

GET/HEAD Case 可给出有序备用 URL，主地址不满足预期时继续尝试，遇到成功停止；原地址失败始终保留，
备用成功不把绑定改判为通过。每次尝试记录提供方、binding、Case、Pod UID/container、请求 URL（查询值脱敏）、
时间、HTTP/transport 结果与 Finding，headers/body/error 附件随 Health Bundle 交付。凭据头与已知签名值脱敏。
二进制文件保留受预算限制的响应内容；响应摘要对应下载流，文本附件可能经脱敏。

无法取得消费关系、无法准备 Pod、无法取得 Case、空 Case 列表和请求失败分别记录阶段和原因；它们不是网络成功。
单个消费扩展或绑定失败不丢失其他结果；证据同时保留消费扩展 ID 与 binding ID，取消保留已完成的尝试。Case 时间是本次执行时间，
`--since` 的历史窗口只用于统计查询。`doctor case` 的现有目录与发送入口保持独立。

消费方声明示例（提供方已在其 Service.extensions 注册 `file-downloads`）：

```ts
const worker = {
  ...workerService,
  extensions: [{
    id: "downloads", kind: "case.consume", access: {},
    run: withSummary({ title: "文件消费关系", fields: [] }, async () => ({
      bindings: [{
        id: "file-download", workload: "main",
        producer: { namespace: "plugin/example/service/files", extension: "file-downloads" },
      }],
    })),
  }],
};
```

`case.produce` 的 `data.cases` 将稳定意图与本次可访问的地址对应：

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

需要真实租户/用户的 `case.produce` 可声明 `requestIdentity: { configured(config) }`，
复用 `ServiceCaseIdentityRequirement`；Plugin 解释自己的配置，Core 只消费返回的 tenantId/userId。
Health prepare 按显式 `--tenant-id` / `--user-id`、Plugin 配置的优先级补齐身份。
缺失时通过 `tenant.list`、`user.search` 选择启用租户及该租户中的真实用户；同一身份只询问一次。
显式切换租户时不沿用原配置租户的用户，需重新选择或提供 `--user-id`。

身份通过 `CaseProduceQuery.requestIdentity` 传入，不修改 profile，也不写入报告。
Case 身份的租户不改变整轮统计范围；只有显式 `--tenant-id` 限定统计。
非交互（包括 `-y`）缺参时，相关绑定记录为 identity 阶段 unavailable，不进入 Pod 或调用 producer；
取消身份选择记录为 cancelled，其余独立检查继续。选择身份不是批准真实请求，非只读 Case 仍需审批。
签名 URL 与独立会话仍由 producer 在每个实例执行前生成，避免准备阶段产生的临时数据过期。

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
