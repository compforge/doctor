# Knowledge

`doctor knowledge` 组织当前 Plugin 和 Service 声明的静态知识，不加载 profile，不准备集群、
数据库或其它 Target 访问，也不调用 Extension。知识定义随 Plugin 版本交付；它提供解释与调查
方向，现场结论仍需 trace、log、data 等证据。

## 动作与作用域

```sh
doctor knowledge                               # 产品概念、流程，文章/词典索引与服务目录
doctor knowledge -s api                        # 单个 Service 的知识
doctor knowledge search "runtime error"        # 产品和全部服务知识
doctor knowledge search "runtime" -s api       # 仅指定 Service
doctor knowledge list --all --kind dictionary  # 产品和全部 Service 的词典索引
doctor knowledge show article/queue#capacity   # 对象或子项的正文
doctor knowledge lookup errors QUEUE_BUSY      # 词典查询
doctor knowledge lookup errors -f json         # 整本词典的条目
```

概览、list、show 与 lookup 的默认作用域是产品级 Knowledge。`-s/--service` 可重复，支持 Service aliases，最终按标准名去重。
指定 Service 时只读取所选服务，不隐式合并产品知识；选项可放在 knowledge 或子命令之后。
`list --all` 同时列出产品与全部 Service，不能与 `--service` 混用。`list --kind` 支持
`concept`、`workflow`、`article`、`dictionary`。

概览按 `Concept / Workflow / Article / Dictionary` 分组：概念以条目展示，流程保留名称、摘要与
编号步骤，文章与词典只列短引用和标题。短引用在对应产品或 Service 作用域内使用 `show` 阅读正文。
所有动作支持 `-f text|json`；概览文本由 Core 按结构化字段紧凑排版，show 与 lookup 调用对象的
Markdown 方法；索引和搜索展示简短条目。
JSON 保留结构，不重复附带生成的正文文本。
`doctor plugin` 保留身份、服务目录、诊断能力与 `upstream` 静态关系，知识正文由本命令展示。

## 搜索与 AI 排查

`search` 不指定 Service 时搜索当前 Plugin 的产品级及全部 Service Knowledge；指定 `-s/--service`
时只搜索所选服务，不包含产品级知识。Service aliases、重复选择去重和父/子命令选项合并规则一致。

搜索对象 ID、标题/名称、说明/摘要、Section 正文、Entry 别名以及 Dictionary 来源字段。
按空白拆分查询词，不区分大小写，所有词必须出现在同一对象或子项的结构化字段中。
父对象的摘要与子项正文分别匹配，避免仅因子项命中而重复返回容器。结果按知识声明顺序返回，
包含归属、完整引用、标题和最多 200 字符的命中附近片段；完整正文通过 `show` 读取。
搜索不执行 Markdown 方法，不加载 profile、客户端或 Extension。无匹配或未加载 Plugin 返回空数组，
空白查询词报错；这是离线文本搜索，后续向量索引可复用相同作用域和引用。

AI 使用 Doctor 或 ascli 时，先通过 `knowledge search` 定位相关知识、`show` 阅读必要正文，
再用 `plugin` 确认服务目录、诊断能力与上游关系。需要排查运行问题时，根据知识中的流程执行
`inspect/collect` 或 `trace/log/data` 等命令取得现场证据，验证判断并继续排查。

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

各知识对象提供 `markdown(): string`；文本展示调用对象自身的方法，父对象组合子对象输出。
JSON 展示只序列化结构化内容，不调用 Markdown 方法。Plugin 加载时验证方法契约，但不执行渲染。
从 JSON 加载知识的 Plugin 负责为各层对象补齐方法，可委托 SDK 导出的 common 转换函数。

原 `error.catalog` Extension 与 `knowledge errors` 已移除，错误目录直接放进
`Knowledge.dictionaries`，使用 `knowledge lookup errors [query]`。错误码可作为字符串 Entry ID，
保留前导零；同一码有多个解释时使用不同稳定 ID，将共享码放进 aliases。
错误的默认消息、HTTP 状态、异常类、处置说明与链接由作者写入 description，Core 不解释业务字段。
额外的类型化字段可以保留在 JSON 中；需要被人阅读的内容须同时体现在通用文本字段里。

`lookup` 不带查询词时列出全部条目；带词时精确匹配 ID，或忽略大小写匹配名称和别名片段。
返回全部匹配项，不按声明顺序挑选一个。空词典与无匹配均成功返回空数组；空白查询词报错。
本地文本搜索由 `search` 提供；向量检索尚未接入。接入示例见 [example Plugin](../../../plugins/example/src/index.ts)。
