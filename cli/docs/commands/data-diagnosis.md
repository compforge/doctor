# Data 汇集诊断

## 理念 / 概念

`doctor data [biz-id...]` 汇集一个或多个业务 ID 在当前 Plugin 中的关联数据，ID 也可通过重复
`--biz-id` 传入。它不是通用 SQL 控制台，也不在
`collect/data` 写死 Plugin、Service 或业务对象：每个 Service 通过 Plugin 的 Service Catalog 声明自己的
`data` capability，声明 `provides` 数据类型，并拥有 ID 解析、固定只读查询、结果摘要和确定性判读。

data capability 的两个角色彼此独立：

- provider：每个 capability 都通过 `provides` 声明并贡献自身数据。
- expander：可选通过 `expands` 声明能解析的规范 ID 类型。一个 Service 可以同时是 expander 和
  provider，扩展出的 ID 也可以继续交给后续 Service 使用。

这里的 expansion 只服务 `doctor data` 的多 Service 数据汇集，不是其它命令的隐式通用依赖。需要规范
`trace_id` 的 `doctor trace` 和 `doctor log` 使用更窄的 `service.traceId` capability。

具体 Plugin capability 自己解释 Service 环境、建立数据库访问并执行固定查询；Catalog 的 data 契约
只回答“能贡献什么业务数据”，不会把 Database client 或业务连接规则注入 Plugin。

## 流程

1. 读取命令行传入的 biz ID，并从 Catalog 选择本次参与的数据 Service。多个 ID 进入同一采集批次，
   但每个 ID 独立执行后续 expansion、provide、Detector 与 Coverage。
2. Doctor 为每个 Service 准备 `PluginContext`，只注入选中的 kubeconfig、Namespace、Service 身份和
   按需 port-forward。Plugin 自行定位运行态、解释配置并返回脱敏的数据源状态。
3. 按 Catalog 顺序串行执行全部带 `expands` 的 capability。第一个接收原始 ID；后续 expander 同时接收
   此前解析出的 ID，因此可逐层扩展。扩展时取得的数据结果同时作为该 Service 的 provider 贡献。
4. expansion 链完成后，所有 Service 都进入 provide 阶段并消费最终去重 ID 集合。Service 在 expansion
   阶段已经查过的 ID 直接复用，只补查后续 expander 新增的 ID。
5. Detector 只根据当前 ID 的结构化 Observation 形成 Finding；Render 汇总其解析方式、规范 ID、服务数据、
   Finding 和 Coverage。批量 HTML 仅在最外层用 tab 组合独立报告；JSON 用 `groups` 按原始 ID 分组。
6. 单个 Service 配置、连接或查询失败只降低该 Service 的 Coverage，其余已取得数据仍然交付。

## 关键设计

### Catalog 声明贡献能力，编排器不认识业务名

`collect/data` 只解释阶段和 capability 协议，不 import `plugins/<plugin>` 的具体 Service。Plugin 通过
Catalog 决定哪些 Service 可扩展 ID、哪些只提供数据；服务 schema、关联键、连接规则和固定查询图留在
具体 Plugin。新增 Plugin 或 Service 不需要修改通用 data 编排器。

### Expansion 是确定性的两阶段依赖

所有 expanders 构成一条稳定的依赖链，每个 Service 的 provide Probe 显式依赖整条链。这保证 provider
不会因注册顺序提前运行，也允许后一个 expander 继续扩展前一个发现的 ID。expander 同时也是 provider；
它在 expansion 阶段的查询结果会被 provide Probe 复用，避免为了角色建模重复访问数据源。首版只执行
一轮 Catalog 顺序的 expansion，避免不受控的循环查询。

### ID 是不带类型的输入，类型来自证据

用户无需先知道业务 ID 的具体类型。每个 capability 以
自身稳定关系尝试解析，并在 Observation 中记录 `inputId`、`resolvedAs` 和解析出的命名 ID。未命中是
证据缺口，不等于异常；只有数据库已经证明的业务不变量才形成 Finding。

### 访问准备与业务查询分开

Doctor 只确认当前环境和 Service 身份，并托管 port-forward 生命周期；Plugin 决定如何定位运行实例、解释配置、使用哪套
HTTP/DB client，以及这些 ID 应查询什么。Plugin 与 Doctor 同进程运行，这个接口是协作契约而非沙箱。
连接凭据只存在于本轮执行态；Facts、Observations 和报告只保留 Plugin 返回的脱敏 endpoint、用户名和
凭据来源。
