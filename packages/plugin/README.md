# @compforge/doctor-plugin

Doctor Plugin 的协议与可选共享 SDK。Plugin 是 Service 与 Skill 的打包和分发单位：一个业务 Plugin
通过本包导出一个 `PluginDefinition`，其中 Service Catalog 可以包含多个 Service，每个 Service 独立声明
`contributions.inspect / probes / detectors`、capability 及其 access，同一精确 Plugin 版本还可携带多个已解析的 Skills。Doctor 只注入
`PluginContext`。其中 Kubernetes access 和 port-forward 由 Core 绑定到已选 Target，具体 HTTP、数据库
协议和业务查询由 Plugin 持有。例如 `traceId` capability 只约定业务 ID 到规范 `trace_id` 的输入输出，
查询哪个 Service、如何解释数据源和 ID 的业务语义都留在 Plugin。

Service 可以通过 `Toolchain` 声明稳定的源码语言、执行平台、依赖管理器和构建工具。该声明帮助 Core
选择通用依赖、性能与产物采集器；当前镜像、runtime version 和实际依赖仍由 Core 从 Target 观察，
Toolchain 不作为现场状态使用，也不携带自定义执行命令。

`PluginDefinition.id` 与 `PluginDefinition.version` 共同构成运行时身份。同一 `plugin@version` 的代码和
Skills 内容不可变；`scripts/version.ts` 对两类内容统一计算并校验版本锁，任一内容变化都需要 bump
Plugin version 后重新封存。

协议返回值既可以是可持久化数据，也可以是临时 capability handle。后者只暴露 Core 需要的规范化身份
和操作方法，适合让原始凭据、厂商字段与请求拼装始终留在 Plugin 内。

Core 通过 contribution 发现和驱动 Inspect、Probe、Detector，通过 capability 复用 Store、Metric、Case 等
业务能力。access 声明、调用时交换的类型化 data、Core 注入的 Target-scoped infra，以及 profile 中
不透明透传的 Plugin config 都只支撑当前贡献或能力调用，不形成平行的扩展生命周期。config 的 schema 与解释权归 Plugin；
kubeconfig、context 等 Core-owned 连接信息不会伪装成 Plugin config。

Core 与 Plugin 共用一套 Inspect → Probe → Detector 诊断流程。Plugin Service 在 `contributions` 中按这三类
统一注册业务逻辑；Core 选择、驱动并校验结果。Service Inspect 接受由类型化 `Identity` 与
capability-specific constraints 组成的 `Query`，并
返回 `InspectQueryResult`。其中 `ValueFact` 表达单值，`RecordFact` 用稳定 key 表达可重复记录，
`RelationFact` 表达已经由现场数据证明的 Identity 关系；记录内部结构对 Core 不透明。
Service Probe 在调用方的每个调度点接受一次 Input 并返回 Observation，不拥有循环、预算、授权或
Evidence。Service Detector 只消费已组织的只读 Evidence，不接收 PluginContext 或执行 I/O。Command 选择能力、限制 Relation 扩展并组织
Evidence。Fact 是本次诊断中可复用的相对稳定信息，Observation 只代表探测时间点或窗口；展示 identifier
不能反向驱动 Query。

Workload Probe 用版本化的 `ObservationDefinition` 同时声明 payload 类型和 JSON Schema：

```ts
import {
  defineObservation,
  defineServiceWorkloadProbe,
  Type,
} from "@compforge/doctor-plugin";

const WorkloadHealth = defineObservation({
  kind: "workload-health",
  schemaVersion: 1,
  schema: Type.Object({
    ready: Type.Boolean(),
    latencyMs: Type.Optional(Type.Number({ minimum: 0 })),
  }, { additionalProperties: false }),
});

export const workloadHealthProbe = defineServiceWorkloadProbe({
  id: "workload-health",
  kind: "workload",
  schemaVersion: 1,
  workload: "main",
  access: {},
  produces: WorkloadHealth,
  probe: async (_context, _input) => ({ ready: true }),
});
```

`probe` 的返回类型由 `schema` 推导；Core 在 Plugin 加载时编译 schema，在每次动态调用后把结果
重新视为 `unknown` 验证。只有通过无强转、无默认值、无字段剔除校验的有限 JSON object 会被复制、
深冻结并进入 Evidence。每个 object schema 都必须显式声明 `additionalProperties`，不允许远程 `$ref`。
`Type.Any/Unknown`、`Type.Refine/Codec/Unsafe` 等无法完整表达为可移植 JSON Schema 的逃生口不可用。

`trace` 是一个 Plugin-level capability：`source` 声明 Core 采集 trace 所需的业务 Store，`analysis` 直接
使用 trace-harness 定义的 `TraceContributions`。分析扩展只能消费已标准化的 Trace IR/Facts；采集、配置、
凭据和外部访问仍在进入 Trace Harness 前完成。

`case` 是 Service 的 Probe Capability，提供稳定 CaseSet 与单次请求 runner；runner 的 `run` 实现
HTTP/SSE、鉴权和协议分类，但不拥有加压循环。`perf` 只在 CaseSet 上声明本次 Case mix 与可观测性预设，
调度、预算、熔断和统计由 Core 的 Perf Harness 统一完成。

`PluginSkill` 是 runtime 视图，不规定归档或磁盘布局。Plugin loader 或定制发行入口负责读取
`SKILL.md`，并把内容及可由宿主 `ExecutionEnv` 访问的绝对路径注入对应 `PluginDefinition`。Skill 因此
跟随 Plugin 安装、选择、信任与升级，同时不让 Plugin SDK 依赖具体 agent framework。
