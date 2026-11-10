# Tenant 数据查询

`doctor tenant` 查看指定租户下的数据。通过 `--tenant-id` 直接指定 ID，或用 `--tenant-name`
精确解析名称；两者互斥。交互终端可从目录选择，查询开始前必须确定租户。

## 类型选择与分页

`--biz-type` 可重复传入多个类型；省略时查询所有已注册且支持租户过滤的类型。`-s` 限定数据提供方
Service，省略时调用所有匹配提供方。命令不接受业务 ID；具体业务对象的关联查询使用 `doctor data`。

```bash
doctor tenant --tenant-name demo --biz-type model --biz-type intention
doctor tenant --tenant-id <id> -s control --biz-type bot --page 2 --page-size 20
```

业务类型由 Service 静态注册，配置、模型、意图等只是 Plugin 定义的类型，Core 不维护类型枚举。
Help 展示支持租户过滤的类型及提供方，不访问目标环境。目录提供方与数据提供方独立选择。

## 数据能力与执行边界

Tenant 解析租户后使用共享的数据查询流程，通过 `data.page` 请求分页数据，不另设 Tenant 数据协议。
Service 必须声明 `supportsTenant`，并将 `tenantId` 同时用于记录查询和计数；不支持时显式失败，
不能忽略条件后返回环境数据。省略类型时不选择这些提供方；显式选择的类型保留各来源的失败结果。

每个 Service/类型独立返回 `items`、`page`、`pageSize`、`total`，记录结构归 Service；Core 不跨来源
合并总数。稳定排序和准确计数归提供方；当前页不表示完整租户盘点，预算截断和查询失败须明确区分。

身份解析、访问准备、查询、Evidence 与输出按同一次调用管理。租户、类型及分页条件参与结果复用键。
JSON、Summary、HTML 和 Bundle 使用同一份已采集证据，一个来源失败仍保留其它来源的成功结果。
模型的实际调用验证仍使用 Model 命令；数据查询成功不代表业务执行成功。

## 只读目录查询

无需执行租户诊断即可查看身份目录：

```bash
doctor tenant list
doctor tenant get --tenant-id <id>
doctor tenant get --tenant-name <name> -f json
doctor tenant users --tenant-name <name> --query <keyword> --page 1 --page-size 20
```

`list` 列出启用租户；`get` 必须且只能指定一个非空的 ID 或名称，并调用 `tenant.resolve` 精确查询。
协议用 `{ id }` 或 `{ name }` 表达查询意图；找不到和访问失败直接返回错误，不尝试另一种选择器。
`users` 同样要求显式租户，按名称时先解析 ID，再调用 `user.search`；直接指定 ID 时仅把它作为查询范围。
省略关键词时列出当前页启用用户，默认第 1 页、每页 20 个，每页上限 100。

目录命令默认输出身份表格，`-f json` 输出结构化对象；用户结果包含 tenantId、query、page、pageSize、
total 和 users。空列表是成功结果，能力缺失、未找到或访问失败不伪装为空列表。
输出只包含身份 ID、名称、显示名称和查询分页信息，可通过 shell 重定向保存；不支持 `-o`。
这些命令只准备所需目录能力的访问，不采集配置或模型事实。原有 `doctor tenant --tenant-id/--tenant-name`
继续运行租户数据查询；其中 ID 参数表示诊断范围，不承担目录存在性验证。
