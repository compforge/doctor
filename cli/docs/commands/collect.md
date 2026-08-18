# doctor collect 集合采集

## 理念 / 概念

`doctor collect [biz-id...]` 是 Data、Trace、Log 和 Metric 的集合命令。它只负责选择采集面、调用已有
collector 并汇总交付，不拥有新的 Fact、Probe、Detector 或业务 capability，也不改变任何具体命令的
采集语义。

单项命令仍是各自证据和生命周期的 owner。需要精确控制某个数据面的范围或参数时直接运行对应命令；
需要一次带走多个数据面的离线报告时使用 `doctor collect`。

## 流程

1. 接收一个或多个业务 ID；交互终端缺省时多选采集命令，非交互模式默认选择全部，也可用
   `--include` 显式指定。
2. 合并所选命令的 Plugin capability contract，并在访问目标环境前完成检查。
3. 依次调用所选的 Data、Trace、Log 和 Metric collector。集合层不读取外部资源，也不实现降级查询。
4. 把各 collector 已生成的自包含 HTML 嵌入同一个 Tab 报告；单项失败不会丢弃其它已交付报告。

## 关键设计

### 集合层只有编排所有权

Data、Trace、Log 和 Metric 是独立证据面，集合命令不能为了统一入口复制它们的配置、访问或判定逻辑。
新增或修正具体采集行为时只修改对应 collector；`doctor collect` 只维护选择、调用和组合交付。

### Metric 保持时间窗口语义

业务 ID 传给 Data、Trace 和 Log。Metric 仍按 Service 与时间窗口采集，集合命令只透传 `--watch`、
`--interval` 和 `--prometheus`；它不会把业务 ID 伪装成 Metric label 或在集合层推导查询语义。

### 部分成功仍然交付

只要至少一个所选 collector 形成报告，集合命令就交付组合 HTML，并在对应 Tab 标明失败的数据面；全部
数据面都未形成报告时才返回失败。每个 Tab 内的 Finding、Coverage 和完整度仍由原 collector 负责。
