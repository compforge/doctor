# Knowledge

`doctor knowledge` 是离线诊断知识入口，首个子命令为 `errors`。知识由当前 Plugin 的
`error.catalog` Extension 提供；查询不加载 profile、不连接集群或数据库。

```sh
doctor knowledge
doctor knowledge errors
doctor knowledge errors QUEUE_BUSY
doctor knowledge errors Queue --extension-namespace plugin/example
doctor knowledge errors QUEUE_BUSY --format json
```

不带查询词时列出所有定义；查询词匹配完整错误码，或忽略大小写匹配名称、别名片段。
错误码是不透明字符串，保留前导零，不跨来源转换数字码与字符串码。
`errors --extension-namespace` 指 Extension namespace，不是根命令的 Kubernetes namespace。
未指定时搜索全部目录；指定时精确匹配，不向父子 namespace 回退。

输出按目录保留 namespace、Extension ID、定义来源及其版本。同一码有多项定义时全部返回，
不按注册顺序选一个。无目录、目录为空和未匹配都属于成功查询，文本给出说明，JSON 保留空数组。
已选择目录加载失败或契约不合法时命令失败，不伪装成未匹配。

## 提供错误定义

Plugin 顶层 `extensions` 注册 `ErrorCatalogExtension`，其同步 `load()` 返回
`{ source: { name, version, reference? }, errors }`；可独立声明产品或服务 namespace。
实现须读取本地随 Plugin 分发的定义，不打开 Target 访问，也不依赖 Service 执行上下文。
类型与运行时校验见 [error-catalog.ts](../../../packages/plugin/src/extension/error-catalog.ts)，
接入示例见 [example Plugin](../../../plugins/example/src/errors.ts)。

每项必填 `code`、`name`、`description`；可附带 `aliases`、`exception`、`defaultMessage`、
`defaultHttpStatus`、`defaultDisposition` 和 `references`。名称在单目录内唯一，错误码允许重复。
来源版本指错误定义的版本，不要求等于 Plugin 版本。

默认消息、HTTP 状态和处置方式是定义知识，不代表某次错误的实际值或已确定根因。
排查仍需对照现场版本、错误 detail 和证据。此入口不执行恢复动作，也不根据码值推导重试策略。
