# Data 汇集诊断

## 理念 / 概念

`doctor data [biz-id...]` 汇集一个或多个业务 ID 在当前 Plugin 中的关联数据，ID 也可通过重复
`--biz-id` 传入。它不是通用 SQL 控制台，也不在
`collect/data` 写死 Plugin、Service 或业务对象：每个 Service 通过 Plugin 的 Service Catalog 声明自己的
`inspect` capability，声明 `provides` 数据类型，并拥有 ID 解析、固定只读查询、结果摘要和确定性判读。

Inspect Capability 接受由业务 Identity 与约束组成的 Query，并返回一个或多个可独立消费的 Fact：

- Fact：每个 capability 通过 `provides` 声明并贡献自身业务数据；同 kind 的列表数据逐条返回，单条内部
  shape 仍由 Plugin 决定。
- Relation：一种 Fact；可选通过 `expands` 声明目标 Identity kind，并返回已由现场数据证明的关联。
  一个 Service 可以同时提供普通 Fact 与 Relation，Relation 的目标 Identity 也可以交给后续 Service 查询。

这里的 expansion 只服务 `doctor data` 的多 Service 数据汇集，不是其它命令的隐式通用依赖。需要规范
`trace_id` 的 `doctor trace` 和 `doctor log` 使用更窄的 `service.traceId` capability。

具体 Plugin capability 自己解释 Service 环境、建立数据库访问并执行固定查询；Catalog 的 Inspect 契约
只回答“能贡献什么业务数据”，不会把 Database client 或业务连接规则注入 Plugin。

## 流程

1. 读取命令行传入的 biz ID，并从 Catalog 选择本次参与的数据 Service。多个 ID 进入同一采集批次，
   但每个 ID 独立执行后续 expansion、provide、Detector 与 Coverage。
2. Doctor 为每个 Service 准备 `PluginContext`，只注入选中的 kubeconfig、Namespace、Service 身份和
   按需 port-forward。Plugin 自行定位运行态、解释配置并返回脱敏的数据源状态。
3. 将原始 ID 放入去重 work queue。只要队列发现新 Identity，就调度所有接受该 kind 且尚未查询过它的
   Relation provider；新的 Relation 再把目标 Identity 加入队列，因此扩展不依赖 Service Catalog 顺序。
   扩展时取得的每个 Fact 同时作为该 Service 的独立数据贡献。
4. expansion 链完成后，所有 Service 都进入 provide 阶段并消费最终去重 ID 集合。Service 在 expansion
   阶段已经查过的 ID 直接复用，只补查后续 Relation 新增的 Identity。
5. Command 将 capability 返回的数据保存为带状态的 Facts（含 Relation），并与访问准备阶段的 Inspect Facts
   一起形成 Evidence；`doctor data` 当前没有额外现场取证动作，因此不产生 Probe Observation。
6. Command 装配 Plugin 提供的纯 Detector 分析 Evidence，形成 Finding 与 Coverage；Render 汇总解析方式、
   规范 ID、服务数据和诊断结论。HTML 中的业务 Fact 按页挂载，并支持对全部记录做关键字过滤后再分页；
   批量 HTML 仅在最外层用 tab 组合独立报告。JSON 写入本地文件，并用 `groups` 按原始 ID 分组。
7. 单个 Service 配置、连接或查询失败只降低该 Service 的 Coverage，其余已取得数据仍然交付。

## 关键设计

### Catalog 声明 Capability，编排器不认识业务名

`collect/data` 只解释阶段和 capability 协议，不 import `plugins/<plugin>` 的具体 Service。Plugin 通过
Catalog 决定哪些 Service 可扩展 ID、哪些只提供数据；服务 schema、关联键、连接规则和固定查询图留在
具体 Plugin。新增 Plugin 或 Service 不需要修改通用 data 编排器。

### Relation 是确定性的两阶段依赖

所有 Relation provider 共享一个按 Identity 去重的 work queue，Data Command 取得有界闭包后才进入
provide。这样 capability 无论以什么 Catalog 顺序注册，都能在其接受的 Identity 出现后运行。提供 Relation
的 capability 也可以同时提供 Fact；它在 expansion 阶段的查询结果会被 provide 阶段复用，避免为了角色
建模重复访问数据源。每个 Service/Identity 组合最多查询一次，扩展深度最多 8 层、Identity 最多 1000 个，
从而隔离环和异常膨胀。

Relation 是 capability 数据结果的一部分；summary 中的 identifier 只用于展示，不参与新 Query 的调度。
Core 校验每个 Fact kind 是否由 `provides` 声明、Relation 的起点是否等于本次 Query Identity、目标 kind
是否由 `expands` 声明，并拥有去重、查询边界和后续调度。

### ID 是不带类型的输入，类型来自证据

用户无需先知道业务 ID 的具体类型。每个 capability 以
自身稳定关系尝试解析，并在 capability Fact 中记录 `inputId`、`resolvedAs` 和解析出的命名 ID。未命中是
证据缺口，不等于异常；只有数据库已经证明的业务不变量才形成 Finding。

### 访问准备与业务查询分开

Doctor 只确认当前环境和 Service 身份，并托管 port-forward 生命周期；Plugin 决定如何定位运行实例、解释配置、使用哪套
HTTP/DB client，以及这些 ID 应查询什么。Plugin 与 Doctor 同进程运行，这个接口是协作契约而非沙箱。
连接凭据只存在于本轮执行态；Facts 和报告只保留 Plugin 返回的脱敏 endpoint、用户名和
凭据来源。
