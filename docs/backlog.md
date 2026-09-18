# Backlog

## Service capabilities 与 contributions 边界

- Doctor 需要 Service 提供数据声明和执行函数；目前 `capabilities` 与 `contributions` 混合承载两者，归属不够清晰。
- 先基于现状梳理：`capabilities` 聚焦声明式数据与资源，`contributions` 聚焦由 Core 调度的业务行为；以完整契约为单位归类，不机械拆开元数据与函数，也不按是否含函数判断资源声明的归属。
- Command 的消费规则与 `plugin` 自描述复用同一份声明，让用户能发现 Service 支持哪些命令、输入与证据，避免另维护能力清单。
- 暂不合并两个概念或统一函数签名；边界清晰后，再根据实际使用评估是否合并。

## Chat execution safety

- Enforce `readonly` as a host-owned tool policy instead of relying on prompts and environment variables.
- Run local Chat tools in a sandbox with explicit filesystem, process, network, and credential boundaries.
