# doctor collect 集合采集

## 理念 / 概念

`doctor collect [biz-id...]` 是 Inspect、Data、Trace、Log 和 Metric 的集合命令。它只负责选择采集面、
调用已有 collector 并汇总交付，不拥有新的 Fact、Probe、Detector 或业务 capability，也不改变任何
具体命令的采集语义。

单项命令仍是各自证据和生命周期的 owner。需要精确控制某个数据面的范围或参数时直接运行对应命令；
需要一次带走多个数据面的离线报告时使用 `doctor collect`。

## 流程

1. 接收一个或多个业务 ID；交互终端缺省时多选采集命令，非交互模式默认选择全部，也可用
   `--include` 显式指定。
2. 合并所选命令的 Plugin capability contract，并在访问目标环境前完成检查。
3. 依次调用所选的 Inspect、Data、Trace、Log 和 Metric collector。集合层不读取外部资源，也不实现
   降级查询。
4. 每个 collector 一次采集同时形成自己的 HTML 和完整 Bundle；集合层把 HTML 嵌入同一个 Tab 报告，
   并把各子 Bundle 原样纳入集合 Bundle。单项失败不会丢弃其它已交付报告。

## 关键设计

### 集合层只有编排所有权

Inspect、Data、Trace、Log 和 Metric 是独立证据面，集合命令不能为了统一入口复制它们的配置、访问或
判定逻辑。新增或修正具体采集行为时只修改对应 collector；`doctor collect` 只维护选择、调用和组合交付。

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

### Metric 保持时间窗口语义

Metric 仍按 Service 与时间窗口采集，集合命令只透传 `--watch`、
`--interval` 和 `--prometheus`；它不会把业务 ID 伪装成 Metric label 或在集合层推导查询语义。

### 部分成功仍然交付

只要至少一个所选 collector 形成报告，集合命令就交付组合 HTML，并在对应 Tab 标明失败的数据面；全部
数据面都未形成报告时才返回失败。未指定 `--format` 时同时输出组合 HTML 和 `tar.gz`，后者的根
`report.html` 是同一组合报告，并包含 Inspect/Data/Trace/Log/Metric 各自的完整子 Bundle。集合层不会为
生成第二种格式重新采集。每个 Tab 内的 Finding、Coverage 和完整度仍由原 collector 负责。

单个 biz-id 的默认文件名为 `doctor-collect-<safe-biz-id>-<timestamp>.html/.tar.gz`；多个 biz-id 使用
`doctor-collect-batch-<timestamp>.html/.tar.gz`。
