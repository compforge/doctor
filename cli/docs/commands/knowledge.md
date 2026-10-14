# Knowledge

`doctor knowledge` 组织当前 Plugin 和 Service 声明的静态知识，不加载 profile，不准备集群、
数据库或其它 Target 访问，也不调用 Extension。知识定义随 Plugin 版本交付；它提供解释与调查
方向，现场结论仍需 trace、log、data 等证据。

## 动作与作用域

```sh
doctor knowledge                               # 产品概念、流程，文章/词典索引与服务目录
doctor knowledge -s api                        # 单个 Service 的知识
doctor knowledge list --all --kind dictionary  # 产品和全部 Service 的词典索引
doctor knowledge show article/queue#capacity   # 对象或子项的正文
doctor knowledge lookup errors QUEUE_BUSY      # 词典查询
doctor knowledge lookup errors -f json         # 整本词典的条目
```

默认作用域是产品级 Knowledge。`-s/--service` 可重复，支持 Service aliases，最终按标准名去重。
指定 Service 时只读取所选服务，不隐式合并产品知识；选项可放在 knowledge 或子命令之后。
`list --all` 同时列出产品与全部 Service，不能与 `--service` 混用。`list --kind` 支持
`concept`、`workflow`、`article`、`dictionary`。

概览展开概念和流程，文章与词典只列索引，正文使用 `show`。所有动作支持 `-f text|json`；
文本从结构生成 Markdown，JSON 保留结构，不重复附带生成的正文文本。
`doctor plugin` 保留身份、服务目录、诊断能力与 `upstream` 静态关系，知识正文由本命令展示。

## 引用

对象短引用为 `<kind>/<id>`，子引用为 `<kind>/<id>#<child-id>`：Workflow 的 Step、Article 的
Section、Dictionary 的 Entry。ID 和子 ID 按 URI component 编码。
完整引用为 `plugin/<plugin-id>[/service/<name>]/<kind>/<id>[#<child-id>]`。

短引用在当前作用域中解析；多服务同名对象报歧义并列出完整引用。完整引用可直接选择所有者，
但不能越过显式 `--service` 的范围。未知服务、对象、子项或不合法声明报错，不退回其它作用域。
未加载 Plugin 的概览与列表显示空目录；显式查找对象时失败。Kubernetes namespace 不影响知识作用域。

## 提供知识

Plugin 与 Service 都声明 `knowledge?: Knowledge`。基础结构和 Markdown 转换来自
`@compforge/harness-common`，Doctor SDK 重导出这些类型，并在动态加载边界校验结构。

- `Concept`：`id`、`name`、`description`。
- `Workflow`：`id`、`title`、`summary`、`steps`；Step 有 `id`、可选 `parentId`、`title`、`description`。
- `Article`：`id`、`title`、`summary`、`sections`；Section 有 `id`、`title`、`body`。
- `Dictionary`：`id`、`title`、`summary`、可选 `source`、`entries`；Entry 有 `id`、`name`、`description`、可选 `aliases`。

同一所有者、同一种类的对象 ID 唯一；同一容器内子项 ID 唯一。Step 父引用允许前向声明，
不能缺失、自指或成环。`source` 保留定义来源 `name`、`version` 和可选 `reference`，版本可独立于 Plugin。

原 `error.catalog` Extension 与 `knowledge errors` 已移除，错误目录直接放进
`Knowledge.dictionaries`，使用 `knowledge lookup errors [query]`。错误码可作为字符串 Entry ID，
保留前导零；同一码有多个解释时使用不同稳定 ID，将共享码放进 aliases。
错误的默认消息、HTTP 状态、异常类、处置说明与链接由作者写入 description，Core 不解释业务字段。
额外的类型化字段可以保留在 JSON 中；需要被人阅读的内容须同时体现在通用文本字段里。

`lookup` 不带查询词时列出全部条目；带词时精确匹配 ID，或忽略大小写匹配名称和别名片段。
返回全部匹配项，不按声明顺序挑选一个。空词典与无匹配均成功返回空数组；空白查询词报错。
此轮不提供全文搜索或 VDB。接入示例见 [example Plugin](../../../plugins/example/src/index.ts)。
