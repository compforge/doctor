# @compforge/doctor-plugin

Doctor 的公共 Plugin SDK。Plugin 将一个应用的 Service 与排障 Skill 打包为可离线分发的版本化交付物；
Service 描述业务身份、运行负载和数据源，并注册可供 Doctor 调用的 Extension。

## 接入方式

Service 在 `extensions` 中提供函数；SDK 的 kind 契约约定输入输出，Command 决定选用哪些实现和如何组合。
例如 `facts.inspect` 返回业务记录与关系，`model.query` 返回模型清单，`workload.probe` 返回现场观察。
声明和发现不执行函数；调用时宿主提供受权限约束的上下文、取消信号与资源生命周期。

`dataSources` 描述可复用的数据访问资源，`detectors` 注册只读 Evidence 的纯分析函数，
`environmentProbes` 声明由 Core 执行的环境检查。这些对象各有所有权，不需要包装成可调用函数。
`configurationInspection` 和 `logs` 控制通用配置与日志采集的参与范围。

Plugin 作者只需导出 `PluginDefinition` 和 Service Catalog。模型、租户等领域的提供方由 Command
从 kind 候选中选择；多候选必须按命令规则明确选择，不用注册顺序决定默认提供方。

## 开发与分发

参考 [示例 Plugin](../../plugins/example) 构建第一个 Plugin。
同一 `plugin@version` 的代码和 Skills 内容不可变；修改后运行 SDK 的版本工具封存内容，
再构建自包含归档。Doctor 与归档的 Plugin API 版本必须精确匹配。

- [Extension 契约与调用边界](../../cli/docs/extension.md)
- [Plugin 安装、版本与信任模型](../../cli/docs/plugin.md)
