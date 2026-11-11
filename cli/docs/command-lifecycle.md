# Command 生命周期

所有主路径共用命令准备、调用作用域和根 Finalize。各路径的领域结果及依赖方向见
[CLI 开发约定](../AGENTS.md#执行模型与调用归属)；Collect 内部的数据流与调度见
[Collect 协议](collect-protocol.md)。

## 三阶段生命周期

```text
Prepare
  → 解析 Config / Profile / Target / Service
  → 选择 Core 与 Plugin Service contributions
  → 形成 access plan 与 CommandContext
  ↓
Execute（Core 驱动）
  → Inspect [Core Inspect + Plugin Service Inspect]
  → 汇总并冻结 Facts
  → Probe(Facts) [Core Probe + Plugin Service Probe]
  → 汇总 Observations，构建 Evidence
  → Detector(Evidence) [Core Detector + Plugin Service Detector]
  → Findings / Diagnosis
  ↓
Finalize
  → 释放共享 Client
  → 根 CommandSpec.serialize（本地持久化 / 显式子执行引用）
  → 按格式触发 CommandSpec.render（本地领域页面 / 子报告组合）
  → Report / Artifact / Bundle
  → Delivery / Cleanup / exit status
```

Inspect 与 Probe 之间存在阶段屏障：选中的 Inspect 全部收敛并冻结 Facts 后，Core 才生成 Probe 计划。
Detector 只能在 Observations 汇总成 Evidence 后运行。Plugin Service 只注册 contribution；阶段推进、
调度、失败隔离和收尾始终由 Core 控制。

## 准备扩展点

`defineCommand` 是独立命令和聚合子命令共用的调用入口。每个 CommandSpec 必须提供 prepare 和 run；
入口先校验输入，再调用 prepare，将其类型化结果传给领域 run。调用者通过封装后的 Command.run 传入
原始 Input，准备结果由命令内部持有。

Prepare 按输入选择本次依赖，完成 Plugin 能力存在性检查、环境准备和已选实现的声明绑定。
公共的能力与环境检查复用 prepareCommandRequirements；没有额外准备工作的命令直接返回输入。
依赖 Extension 声明的请求身份也由 prepare 补齐：按需发现目录、应用参数与配置优先级，并通过共享 Decision 完成交互选择。
准备结果向 run 传递已解析的依赖与输入，不让执行中的每个实例重复询问。
validate 负责不访问外部资源的输入校验，在加载 Plugin 和访问环境前拒绝无效请求。

prepare 根据本次输入选择并绑定资源和能力，Service 则提供 Workload、DataSource、capability 与 access
声明及实现。Service 不接收 Command DTO，也不根据命令名切换业务行为。内置工作和 Service contribution
通过相同的执行契约进入系列引擎；Plugin 适配层保留来源、受限上下文与结果校验。

准备结果属于命令内部，可以包含运行时 handle，不要求可序列化。prepare 与 run 处于同一个调用资源
作用域和幂等复用单元：准备失败时保留已登记产物并释放局部资源；prepare 返回 undefined 表示取消，
中止本轮且不进入 run。共享客户端仍由根 Finalize 回收。准备期间的外部访问同样必须先检查 access；
需要作为 Evidence 留存的现场获取结果继续通过 Inspect 等取证流程处理。

Plugin 的每次 Kubernetes 操作都先检查所属 capability 的 access 声明，再由目标 API 判权；不在调用前
汇总预检所有候选路径。Core 自身的权限诊断与用户审批仍按具体命令执行。
聚合命令准备自身依赖，子命令在被调用时独立准备，以保留逐项失败隔离和部分完成结果。

Execute 的内部流程由命令系列决定；Collect 使用 Inspect → Probe → Detector，Provision 等系列保留
自身领域流程。Finalize 统一消费 CommandResult，通过 serialize/render 完成本地持久化与交付。

## Service 选择

业务 Service 选择统一使用可重复的 `-s, --service <name>`，例如 `-s api -s worker`。
Command 输入使用 `services: string[]`，一个 Service 也是长度为 1 的数组；不使用逗号字符串或
另设 `--services`。省略选择沿用各命令的默认范围，显式选择按 Catalog 解析别名并去重。
原本逐目标执行的 DB、S3、Store、Eval、Perf 复用 Command 准备、执行和结果组合协议逐服务运行；
每个 Service 保留独立结果和证据，失败不丢弃其它服务结果，取消停止后续执行。


## CommandSpec 与执行入口

每个常规命令提供 `CommandSpec<Input, Output>`，普通命令和组合命令共用
`run(context, input): Promise<CommandResult<Output>>`。CLI 将 flags 转为领域 Input；父命令直接调用
子命令的同一入口。`defineCommand` 包装校验、环境准备、取消与资源收尾，因此嵌套调用仍需满足自身
的 capability 和 access 前提。

根入口只解析一次 Profile，选定的 Plugin 及其配置校验在整轮内复用。每次调用按顺序执行：

```text
validate domain input
  → required Plugin capability + validated Plugin config
  → declared Host / Kubernetes environment
  → selected Target + scoped capability declarations
  → domain work or child Command.run calls
  → invocation result + resource cleanup
```

组合命令逐个调用已选择的子命令；一个子命令不可用时，其它独立子命令仍可执行。子命令的必要条件
不能简单合并成父命令的全局门槛，否则缺少一种证据能力就会阻断整个概览或采集。

Input 可以提供 `idempotencyKey(): string`，显式声明本次逻辑执行的身份。`defineCommand` 在输入校验后，
按 Command 定义身份和 key 在当前 CommandContext 中合并调用：正在执行时等待同一个 Promise，包括资源
清理；已完成时返回原状态、Output 和 Artifacts，不产生 skipped 状态。未提供方法时每次独立
执行。完成结果包括 partial 和 failed，本轮不隐式重试；取消始终优先于复用。key 必须包含会改变结果的
领域参数，Profile、Plugin 和宿主配置由当前 Context 隔离，记录不跨 Doctor 运行保留。

Inspect 和 Tenant 的 Input 构造函数按检查范围、租户及采集参数生成 key，Collect 使用这些 Input 调用
子命令。调用方仍显式纳入子产物，Artifacts 按产物 ID 去重，因此多个 Collect 可引用同一份环境/租户证据，
最终报告只交付一份。Overview 无需识别第一次或后续 Collect。

## Context 与调用归属

`CommandContext` 属于整轮执行树，保存 Profile、当前 Plugin、按需准备并复用的环境信息、权限检查、
Decision、ExecutionRecord、共享 ClientManager 与取消信号。领域 Context 保存单次执行准备的 Target、client、
Bundle 和领域状态；PluginContext 只暴露本次 Service 调用所需的受限依赖与 infra。

同一 CommandContext 可以被并发子命令共享。Artifacts 使用异步调用作用域，每次调用返回自己的产物
引用，父命令显式选择并纳入子产物；不能按全局列表位置或命令名猜测产物属于哪次调用。
领域输入与输出通过 Input / Output 传递，不放入共享 Context。

报告命名由根命令的 `CommandSpec.reportName(input, result, now)` 在 finalize 交付时推导；run 与
子命令结果不携带报告名称。hook 可从离线结果提取业务 ID，也要处理失败或取消时缺少 Output 的情况；
未提供名称时使用带时间戳的命令名，显式 `--output` 仍由 delivery 处理。

Artifact ID 标识一份具体产物，command 幂等 key 标识一次可复用执行，两者职责独立。CommandArtifacts
统一使用 add 登记或添加引用：首次登记由 Core 分配 ID，同一本轮内重复登记规范化源路径返回原引用；
已携带 ID 时保留身份，并校验其 command 与来源路径一致。父命令添加子结果不会重新分配 ID，幂等返回的
结果自然引用原产物。文件名和时间戳只用于阅读，不能承担产物唯一性。

Host 创建的 PluginContext 继承当前调用的取消信号，并登记到本次调用的资源作用域。显式 dispose
和执行层兜底清理共用一次回收；子调用只关闭自己的资源，不关闭父调用的资源。用户取消会传播到整轮
执行树，停止后续工作，并保留已生成证据。


共享 Client 的身份、初始化与销毁顺序见 [数据源生命周期](datasource.md)。直接嵌入 CommandSpec 的
宿主也负责在整棵调用树结束后调用根 Context 的 `disposeClients`；CLI 在 Finalize 统一完成。

## 结果与交付

run、serialize 和 render 绑定到同一领域 Output；父命令显式组合子结果与子报告。
本地持久化、结果复用、失败保留及最终格式见 [Command 输出规范](command-output.md#finalize-与格式)，
页面组织见 [HTML 报告渲染](rendering.md)。init/profile 等启动命令不要求已有 Profile。
