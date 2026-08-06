# @compforge/doctor-plugin

Doctor Plugin 的协议与可选共享 SDK。一个业务 Plugin 通过本包导出一个 `PluginDefinition`，声明
Service Catalog、capability，以及同一精确 Plugin 版本已经解析的 Skills；Doctor 只注入
`PluginContext`，具体 HTTP、数据库和业务查询实现由 Plugin 自行持有。例如 `traceId` capability 只
约定业务 ID 到规范 `trace_id` 的输入输出，查询哪个 Service、如何访问数据源以及 ID 的业务语义都
留在 Plugin。

协议返回值既可以是可持久化数据，也可以是临时 capability handle。后者只暴露 Core 需要的规范化身份
和操作方法，适合让原始凭据、厂商字段与请求拼装始终留在 Plugin 内。

`PluginSkill` 是 runtime 视图，不规定归档或磁盘布局。Plugin loader 或定制发行入口负责读取
`SKILL.md`，并把内容及可由宿主 `ExecutionEnv` 访问的绝对路径注入对应 `PluginDefinition`。Skill 因此
跟随 Plugin 安装、选择、信任与升级，同时不让 Plugin SDK 依赖具体 agent framework。
