# @compforge/doctor-plugin

Doctor 的公共 Plugin SDK。一个 Plugin 可以为多个 Service 提供业务能力、知识与排障 Skill。

## 接入一个 Service

1. 从[示例 Plugin 的入口](../../plugins/example/src/index.ts)开始，导出 Plugin 定义并建立 Service Catalog。为服务声明稳定名称、Component 和 Workload。Catalog 可以离线加载。
2. 根据诊断目标选择声明。数据访问放在 `dataSources`，可复用的请求输入放在 `cases`，静态 API 和调用关系放在 `operations`。命令需要 Plugin 执行业务查询时，通过 `extensions` 声明 kind、实现和所需 access。分别见 [Service 声明](../../cli/docs/service.md) 和 [Extension 调用契约](../../cli/docs/extension.md)。
3. 在[示例目录](../../plugins/example/README.md)运行 `make build`，用 `doctor plugin install <归档路径>` 安装生成的归档。修改代码或 Skills 后提升 Plugin 版本并封存内容。宿主与归档须使用相同的 Plugin API 版本。参见 [Plugin 分发与加载](../../cli/docs/plugin.md)。
4. 用下面两条命令验证示例。第一条从当前 Catalog 读取 Service 声明；第二条列出 API 提供的 Case 及其消费关系。要验证 Worker 能在部署环境中访问 API，运行 `doctor health --service example-worker` 并选择相应检查。

```sh
doctor plugin --service example-api --format json
doctor case --list --service example-api
```

选择诊断命令见 [CLI 使用指南](../../cli/README.md#命令)。构建内置 Plugin 的定制 CLI 见[发行版](../../cli/docs/distribution.md)。
