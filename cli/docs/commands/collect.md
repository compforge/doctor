# doctor collect 集合采集

## 理念 / 概念

**Collect 的交付目标是一份自描述的诊断归档。** 设想一个能解压和读取文件、第一次接触该产品的 AI，
手头只有用户的原始问题和这份 `tar.gz`。它应能从包内了解本次采集的对象、时间和覆盖范围，
按 Service 找到相关记录，借助采集时 Plugin 声明的知识和调用关系解释记录，并引用原始证据回答问题。
如果当前材料不足以作答，它应能指出缺少哪条知识或现场证据，以及这会影响哪个判断。
归档的[离线阅读入口](#按-service-离线阅读)应支持这一过程，无需依赖先前会话的记忆或访问原环境。

`doctor collect [biz-id...]` 是 Inspect、Tenant、Data、Trace 和 Log 的集合命令。它只负责选择采集面、
调用已有 collector，不拥有新的 Fact、Probe、Detector、业务 capability 或交付实现，也不改变任何
具体命令的采集语义。

Data、Trace、Log 以业务 ID 列表为执行单位；单 ID 是只有一个元素的列表，使用相同的采集、诊断与
交付路径。命令一次准备共享访问与数据源，再形成逐 ID 的 `items` 结果；每项保留状态、失败原因和
自身的 Artifact 引用。汇总状态由这些结果归约，某项失败不抹掉其它项的证据。

单项命令仍是各自证据和生命周期的 owner。需要精确控制某个数据面的范围或参数时直接运行对应命令；
需要一次带走多个数据面的离线报告时使用 `doctor collect`。

Application 数据按查询粒度进入不同数据面：Tenant 承载 tenant-id 粒度，Data 承载 biz-id 粒度；未来若
增加 user-id 等稳定作用域，也由对应具体命令拥有其数据模型。Collect 只透传各数据面自己的 identifier，
不推导 tenant、biz-id、user-id 之间的 Plugin 私有关联。

## 流程

1. 接收采集面需要的作用域参数：Data/Trace/Log 使用一个或多个业务 ID，Tenant 使用 tenant ID/name；
   默认选择全部采集项。交互终端可直接按 Enter 确认，也可调整选项。用 `--include` 可显式指定采集项。
2. 各子命令按自己的 Plugin capability contract 检查前提，单个采集面不可用不阻断其它采集面。
3. 依次调用所选的 Inspect、Tenant、Data、Trace 和 Log collector。集合层不读取外部资源，也不实现
   降级查询。
4. 每个 collector 注册自己的 Artifacts 并返回结构化结果。根 Finalize 调用 Collect renderer，显式组合
   子 Command 的 Report；Delivery 生成离线 HTML 并将报告和全部 Artifacts 放入一个 Bundle。

## 关键设计

### 集合层只有编排所有权

Inspect、Tenant、Data、Trace 和 Log 是独立证据面，集合命令不能为了统一入口复制它们的配置、访问或
判定逻辑。新增或修正具体采集行为时只修改对应 collector；`doctor collect` 只维护选择和调用，组合交付
属于共享 finalize 阶段。

每个具体 command 既能独立执行，也能被 `doctor collect` 以同一入口驱动。独立执行时，command 自行完成
必要的用户交互并把结果形成领域 Config；组合执行时，集合命令为所有 collector 传入同一个
`CommandContext`，kubeconfig/context 等启动事实与 namespace 等同语义用户决策可直接复用，避免下游
重复探测或询问。每个 collector 仍将最终决策写入自己的 Config，并独立拥有后续的 preparation、
`XxxCommandContext` 和 Evidence 生命周期。
不同诊断目的的 Service、Pod 或采集范围不因候选值相同而自动复用，只有语义作用域一致的决策才共享。

### Inspect 保持 Service 范围与敏感数据确认语义

Inspect 默认覆盖 Plugin Catalog 声明的全部 Service；`--deployment-config` 和 `--dependencies` 仍沿用
`doctor inspect` 的敏感数据确认语义，非交互模式缺省跳过。注册 `request.workloads` 的 Plugin 可按 biz ID 返回完整 Workload；Inspect 和 Log 共用解析结果。
跨 Service 返回的 Pod 按其 `service` 归档。批量输入逐 ID 保存 Inspect 证据。

### Tenant 保持独立聚合粒度

Tenant 使用 `--tenant-id` / `--tenant-name`，租户选择独立于业务 ID。组合执行把租户选择
记录在共享 `CommandContext`，但集合层不尝试从 biz-id 推导租户，也不读取 Model Catalog。非交互环境
选择 tenant 数据面时必须显式给出租户。

### Log 与事件共用显式时间窗

`--since`、`--since-time`、`--until-time` 适用于 Log 和 Data/Inspect 中的历史事件。
绝对起点优先；相对窗口在准备前以显式终点或当前时刻解析一次，所有子命令沿用相同边界。
未提供这些参数时，各采集器保留自己的默认策略。窗口不会把数据库记录、Pod 当前状态变成历史快照，
也不会改变按业务 ID 获取 Trace 的语义。协议见 [Inspect 查询时间窗](data.md#inspect-查询时间窗)。

### 部分成功仍然交付

只要至少一个所选 collector 形成报告，集合命令即可进入统一 Delivery；全部数据面都未形成报告时才返回
失败。未指定 `--format` 时同时输出组合 HTML 和 `tar.gz`：HTML 导航由 Collect renderer 显式组合，
Command tabs 与业务对象选择联动；共享环境、租户和时间窗口各自保留作用域。Bundle 根 `report.html`
是完整报告。Collect manifest 保存目标、参数、窗口，并通过 children 引用直接子执行；diagnosis 的步骤
摘要关联各子结果，子执行 manifest 保留其状态和 Evidence 索引。聚合命令可以继续嵌套，共享子结果只落盘一份。每个 Tab
内的 Finding 和完整度仍由原 collector 负责；集合 manifest 仅提供机器分析入口，不增加 HTML
汇总页。

单个 biz-id 的默认文件名为 `doctor-collect-<safe-biz-id>-<timestamp>.html/.tar.gz`；多个 biz-id 或不使用
biz-id 的数据面组合使用 `doctor-collect-batch-<timestamp>.html/.tar.gz`。组合命令只向 Artifact 注册表
提供该 basename，最终路径与格式仍由统一 Delivery 决定；自动化调用可用 `--output` 指定稳定前缀。

渲染契约与四种阅读场景见 [HTML 报告渲染](../report.md)。

### 按 Service 离线阅读

归档根 `summary.md` 展示查询范围、采集时间和 Service 目录。每个服务页
`services/<service>/summary.md` 按来源列出本次记录、定位字段和采集缺口。
服务归属来自采集者记录的 Service 或 Trace 节点的 Service 与 Catalog 名称、别名的匹配。
批量输入共享的 Data 记录保留关联输入；跨服务 Trace 的各入口引用同一份原始文件。
未取得服务归属的证据和命令级失败继续从命令导航、manifest 读取。

服务页可附当前 Plugin 版本声明的 `knowledge.md`，产品级知识由各页引用同一份
`knowledge/product.md`。知识解释术语、状态及服务关系，现场判断引用本包证据。
有 Operation 声明时，`knowledge/operations.md` 按服务列出 Operation 和直接调用目标，
保留服务内部调用。服务页按 `calls`（常规路径）与 `mayCalls`（条件路径）分列直接上游调用方、
下游被调用方，同组内每个 Service 只展示一次。对端有证据页时可以直接跳转。
这份静态声明可用于决定下一步看哪个服务，某次请求实际经过的路径由 Trace 或日志核实。
根 `AGENTS.md` 在生成服务页时说明按 Service 查证的阅读顺序。
