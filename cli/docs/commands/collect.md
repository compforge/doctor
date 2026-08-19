# doctor collect 集合采集

## 理念 / 概念

`doctor collect [biz-id...]` 是 Inspect、Tenant、Data、Trace、Log 和 Metric 的集合命令。它只负责选择采集面、
调用已有 collector，不拥有新的 Fact、Probe、Detector、业务 capability 或交付实现，也不改变任何
具体命令的采集语义。

单项命令仍是各自证据和生命周期的 owner。需要精确控制某个数据面的范围或参数时直接运行对应命令；
需要一次带走多个数据面的离线报告时使用 `doctor collect`。

Application 数据按查询粒度进入不同数据面：Tenant 承载 tenant-id 粒度，Data 承载 biz-id 粒度；未来若
增加 user-id 等稳定作用域，也由对应具体命令拥有其数据模型。Collect 只透传各数据面自己的 identifier，
不推导 tenant、biz-id、user-id 之间的 Plugin 私有关联。

## 流程

1. 接收采集面需要的作用域参数：Data/Trace/Log 使用一个或多个业务 ID，Tenant 使用 tenant ID/name；
   交互终端缺省时多选采集命令，非交互模式默认选择全部，也可用 `--include` 显式指定。
2. 合并所选命令的 Plugin capability contract，并在访问目标环境前完成检查。
3. 依次调用所选的 Inspect、Tenant、Data、Trace、Log 和 Metric collector。集合层不读取外部资源，也不实现
   降级查询。
4. 每个 collector 按本次 format 准备并注册自己的 Artifacts。集合层只触发调用；统一 Delivery 把多个
   command 的 HTML 合成顶部 Tab，并把全部 artifact 目录压入同一个 Bundle。单项失败不会丢弃其它产物。

## 关键设计

### 集合层只有编排所有权

Inspect、Tenant、Data、Trace、Log 和 Metric 是独立证据面，集合命令不能为了统一入口复制它们的配置、访问或
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
`doctor inspect` 的敏感数据确认语义，非交互模式缺省跳过。业务 ID 传给 Data、Trace 和 Log，Inspect
不把业务 ID 解释为 Service 或 Pod 范围。

### Tenant 保持独立聚合粒度

Tenant 使用 `--tenant-id` / `--tenant-name`，业务 ID 仍只传给 Data、Trace 和 Log。组合执行把租户选择
记录在共享 `CommandContext`，但集合层不尝试从 biz-id 推导租户，也不读取 Model Catalog。非交互环境
选择 tenant 数据面时必须显式给出租户。

### Metric 保持时间窗口语义

Metric 仍按 Service 与时间窗口采集，集合命令只透传 `--watch`、
`--interval` 和 `--prometheus`；它不会把业务 ID 伪装成 Metric label 或在集合层推导查询语义。

### 部分成功仍然交付

只要至少一个所选 collector 形成报告，集合命令即可进入统一 Delivery；全部数据面都未形成报告时才返回
失败。未指定 `--format` 时同时输出组合 HTML 和 `tar.gz`：HTML 的 Tab 由 Delivery 根据各 command 注册的
报告生成，Bundle 直接包含 Inspect/Tenant/Data/Trace/Log/Metric 的完整 artifact 目录。每个 Tab 内的 Finding、
Coverage 和完整度仍由原 collector 负责。

单个 biz-id 的默认文件名为 `doctor-collect-<safe-biz-id>-<timestamp>.html/.tar.gz`；多个 biz-id 或不使用
biz-id 的数据面组合使用 `doctor-collect-batch-<timestamp>.html/.tar.gz`。组合命令只向 Artifact 注册表
提供该 basename，最终路径与格式仍由统一 Delivery 决定；自动化调用可用 `--output` 指定稳定前缀。
