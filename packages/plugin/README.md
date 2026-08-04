# @compforge/doctor-plugin

Doctor Plugin 的协议与可选共享 SDK。一个业务 Plugin 通过本包导出一个 `PluginDefinition`，声明
Service Catalog 和 capability；Doctor 只注入 `PluginContext`，具体 HTTP、数据库和业务查询实现由
Plugin 自行持有。
