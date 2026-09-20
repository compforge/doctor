# Extension：Command 与 Service 的扩展协议

## 理念与概念

Extension 是 Service 向 Command 提供数据或执行能力的通用协议，服务于所有 Command 系列。它把双方的
接缝收敛为一个可调用函数 `run`：kind 约定函数语义、input、output 和 access。提供数据同样通过函数
完成；静态数据可以由无业务入参的函数返回，需要查询条件的数据使用相应 input。

通用协议只规范这次函数调用的发现、权限和输入输出契约。Service 自由组织资源并实现函数，Command
拥有自己的执行流程，自由决定在何处调用、如何组合结果以及如何处理失败。

一个 Service 可以提供多个 kind 的 Extension，一个 Command 可以使用多个 kind；同一个 kind 也可以被
不同 Command 复用。kind 按领域操作划分，不与 CLI 命令一一对应。

| 概念 | 职责 |
|---|---|
| Extension | 按 kind 声明并实现一个对外函数，包含实现身份和访问需求 |
| kind | 标识领域契约，约定函数语义、input / output、权限要求及错误语义 |
| Service | Extension 的提供方，组织业务身份、资源与具体实现 |
| Command | Extension 的消费方，决定选择范围、调用时机及如何使用结果 |
| Core | 提供发现、权限检查、受限上下文及资源生命周期机制 |

## 公共契约与代码归属

Extension、kind 及其对应的 input / output 契约统一定义在 Plugin SDK，Command 和 Service 共同依赖：

```text
packages/plugin/src/
├── extension/
│   ├── index.ts          # Extension、ExtensionContext、公共声明校验与统一导出
│   ├── facts-inspect.ts  # facts.inspect 的领域契约
│   ├── trace-resolve.ts  # trace.resolve 的领域契约
│   ├── overview.ts       # overview.summarize / overview.sample 的领域契约
│   ├── tenant.ts         # tenant.list / tenant.resolve / user.search 的领域契约
│   ├── mcp.ts            # mcp.configuration 的领域契约
│   ├── model.ts          # 模型目录、Backend 与推理的领域契约
│   └── service-extensions.ts # Service 声明的统一发现视图
└── kubernetes.ts         # 复用现有 CapabilityAccess
```

公共接口见 [extension/index.ts](../../packages/plugin/src/extension/index.ts)：

```ts
interface Extension<Input, Output> {
  readonly id: string;
  readonly kind: string;
  readonly description?: string;
  readonly access: CapabilityAccess;

  run(context: ExtensionContext, input: Input): Promise<Output>;
}
```

id 是所属 Service 内唯一的实现标识，kind 是提供方与消费方共享的契约标识。相同 kind 可以有多个
实现；消费方根据自己的领域规则决定选择一个、调用多个或拒绝歧义，不能默认按注册顺序取第一个。

kind 保持开放字符串，各领域在 SDK 中组织自己的类型与校验，不建立中央 ExtensionContracts 映射或
封闭枚举。新增 kind 不需要修改 Core 的通用发现与调用机制。accepts、provides 等匹配信息属于需要它们
的具体 kind，不作为所有 Extension 的强制字段。

TypeScript 泛型帮助双方表达类型，但不能证明动态加载的实现符合契约。注册时校验公共声明，消费方在
领域边界校验 kind 的声明和输出；单靠字符串匹配不能省略校验。

## Command 如何使用 Extension

Command 保持 Prepare → Execute → Finalize 的生命周期。Extension 的调用嵌入 Command 自己的流程，
不为它建立额外的执行计划或工作流。

1. **声明与发现**：Service.extensions 注册实现。Catalog.extensions(kind) 按 kind 返回 Service 与实现；
   发现只读取声明，不调用 run，不初始化业务 Client。
2. **Prepare**：Command 按本次输入和 Service 范围选择所需扩展，检查自身及 Extension.access 的权限。
   已选实现可以保存在 Command 自己的 Prepared 中；此阶段不调用扩展取业务数据或执行操作。
3. **Execute**：Command.run 执行自身逻辑，在需要的位置通过宿主调用 Extension.run。Command 决定输入、
   调用顺序、并发、分支、重试与结果组合，并遵守对应 kind 的调用前提和错误语义。
4. **Finalize**：Command 将本次结果交给序列化与渲染。Finalize 消费已取得的本地结果，不继续调用扩展取数。

prepare 确定已知的权限范围，不要求预先列出完整执行路径。运行中才发现的扩展仍须在调用前完成权限
检查；已有候选检查通过，不代表后续任意调用都已获准。

不同 Command 系列保持自己的执行模型。Collect 的 Inspect、Probe、Detector、Evidence 与预算由 Collect
拥有。

## 权限、上下文与资源

CapabilityAccess 声明具体实现的访问需求，prepare 无需执行函数即可读取。命令按本次实际选择的扩展
及自身动作检查权限，同一 Service 或 Plugin 中未参与的扩展不会扩大检查范围。

汇总权限用于检查，不代表将权限并集交给每个实现。ExtensionContext 只提供该次调用需要的配置、受限
访问、取消信号和资源管理能力；当前实现复用 PluginContext。调用复用宿主已有的权限、Client 与清理机制。

临时资源随调用作用域回收，共享 Client 由根执行生命周期管理。扩展不能关闭借用的共享 Client；失败、
取消和正常返回都必须保留正确的资源所有权。结果归属应保留 Service 与具体实现 ID，便于追溯来源。

## 领域操作

| kind | 输入 → 输出 | 消费方 |
|---|---|---|
| facts.inspect | Query 列表 → 逐项 Fact 获取结果 | Data、Tenant |
| trace.resolve | 业务 ID → 一条或多条 Trace 定位结果，包含来源 | Trace、Log，以及调用它们的组合命令 |
| overview.summarize | 时间窗口、租户、预算 → Facet 汇总 | Overview |
| overview.sample | Facet、Entry、窗口、数量 → 代表业务 ID | Overview |
| tenant.list | 无业务入参 → 启用租户列表 | Tenant、Model/Chat、Eval、Perf |
| tenant.resolve | 租户名称 → 租户身份 | Tenant、Model/Chat |
| user.search | 租户、关键词、分页 → 启用用户页 | Eval、Perf |
| mcp.configuration | 超时预算 → MCP server、工具与连接配置投影 | MCP |
| model.query | 租户 Identity、模型类型 → 模型列表 | Model、Chat、Tenant |
| model.backend.inspect | 模型 → Backend 公共身份或不存在 | Model |
| model.backend.validate | 模型、超时预算 → 校验响应 | Model |
| model.invoke | 推理目标、路径、请求体、超时预算 → 完整响应 | Model |
| metric.configuration | 无入参 → 抓取端点、指标名、图表与阈值规则 | Metric、Perf |
| model.stream | 推理请求、取消信号 → 响应头与可读字节流 | Chat、Model Performance |

Trace 按 Service 顺序尝试未解析的业务 ID，保留来源并按业务 ID 与 trace ID 去重。Overview 按 Service
关联汇总和采样，分别检查两次操作的访问需求；仅提供汇总的 Service 可以独立展示概览。
这两个领域均要求每个 Service 对同一操作提供一个实现，重复声明在消费时报告歧义。

目录操作分别声明访问需求，消费方按实际需要调用，每次调用结束后释放受限上下文。
用户选择属于 Command：Plugin 返回租户或用户候选，Command 决定提示、分页和取消。
MCP 配置扩展负责把私有来源投影为公共 server/tool 契约，Command 根据投影完成目标选择与协议探测。
配置读取与 gateway 探测使用各自的权限上下文，避免把 Command 的访问需求扩散给配置提供方。
目录和 MCP 均按 Service 选择每个操作的唯一实现，重复实现报告歧义。

模型目录、Backend 信息读取、主动校验与推理分别选择实现、检查访问权限。Backend Inspect 只返回公共
身份；验证调用在 Probe 中执行，厂商配置与凭据由 Service 自己解析。Command 可把独立操作组合成本地
使用接口，跨 Service 接缝传递的仍是对应 kind 的输入输出。

流式响应以 body 的终态作为调用结束：宿主在收到响应头后继续保留受限上下文，逐次读取上游流以
保留背压，并显式传递读取错误和取消信号。正常结束、消费方取消、请求取消及父命令取消都会触发资源释放；普通
查询和非流式调用在结果返回后释放。只提供流式或非流式推理的 Service 可供相应消费路径单独使用。

## 接入示例：Data 使用 facts.inspect

Data 使用 [facts.inspect](../../packages/plugin/src/extension/facts-inspect.ts) 接入这套协议：

- input 是 Query 列表，每个 Query 保留 Identity、约束和预算；output 按 Identity 返回 collected / failed outcome。
- accepts、provides、expands 描述此 kind 的输入匹配和可能产出的 Fact / Relation 类型。
- Data 的 CommandSpec.prepare 选择实现并检查权限，run 才创建受限上下文和调用取数。
- Data 继续负责批量、Relation 遍历、预算、逐项失败隔离、结果投影与诊断；原生扩展无需数据库式 target。

Data 按 Service 归属查询与结果，因此每个 Service 只选择一个 facts.inspect 实现，多个实现会报歧义。

Data 的具体行为见 [Data 汇集诊断](commands/data-diagnosis.md)；Plugin 的加载、分发与信任边界见
[Plugin](plugin.md)，Command 生命周期见 [Kernel](kernel.md)。

Metric 在抓取前读取每个 Service 的配置快照，查询与 Detector 共用该快照。配置函数的访问权限与
Command 抓取 metrics endpoint 的权限分别检查。无 Kubernetes 访问需求的函数使用 Host 上下文，
保留共享 Client、取消和清理机制；声明 Kubernetes 访问需求的函数使用解析后的集群上下文。
