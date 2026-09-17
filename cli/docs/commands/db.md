# 数据库取证

## 理念与边界

`doctor db` 以业务 Service 为入口，发现其账号可见的数据库、表与建表语句，并执行有界只读 SQL。
`doctor store` 保持健康、容量与负载的宏观诊断；`doctor data` 保持业务 Identity 驱动的固定事实采集。
db 不提供写入、批量脚本、持久 SQL REPL 或跨连接查询拼接。

Service 通过 `capabilities.dataSources[]` 贡献访问能力，不增加数据库注册表。
每个 MySQL 数据源使用两种互斥声明之一：标准 `envPrefix`，或带稳定 key 与 Client 工厂的
`source`。工厂收到根执行拥有的受控上下文，客户端初始化时解释服务私有配置与准备连接；
Service 不拥有连接的销毁权，也不维护第二份数据库、表或 schema 清单。

`store`、`db` 和业务 Inspect 可以消费同一个 source。数据库访问准备归共享 datasource 层，
不依赖 Store 命令的输出选项、报告或调度；每次 SQL 与证据仍独立，客户端复用不等于缓存查询结果。

## 主流程

CLI 校验输入 → 选择 Service → 解析访问目标 → 借用根 Client → 有界发现库表 → 唯一目标选择
→ 只读查询 → Evidence → 根 Finalize / Delivery。

同一账号、实例的重复声明合并为一个查询路由目标，不同账号或实例的同名库表不能按名字合并。
发现失败或截断时可以交付部分清单，但不能据剩余候选证明唯一性并执行 SQL。即使显式提供
database/table 后仍然存在同名目标，也必须失败；不暴露 `--store`，不广播 SQL。

`--show-databases` 表示当前账号可见的数据库，不保证拥有其中所有表的读取权限。
发现结果保留 Service 声明的 DataSource ID、可选 `description` 与实际可见的库名，供人和 AI 区分用途。
同一连接的多条声明即使合并查询，说明仍全部保留；说明只是声明元数据，不参与路由或连接身份，
也不能证明数据存在或账号拥有权限。不要在 description 中填写凭据。
表名用于选择目标，并非 SQL 模板变量，不改写用户 SQL，也不把查询限制为只访问该表。
选定同一连接后，SQL 可按账号权限引用其它库或表。

## 使用

```bash
doctor db
doctor db --service chat --show-databases
doctor db --service chat --database app --show-tables
doctor db --service chat --table app.messages --show-create-table
doctor db --service chat --database app --table messages --show-create-table
doctor db --service chat --table app.messages \
  -e 'SELECT id, status FROM messages WHERE id = ?' --params '["msg:123"]' \
  --format manifest
doctor db --service chat --table app.messages --file query.sql
doctor db --service chat --table app.messages --file - <<'SQL'
SELECT id, content FROM messages WHERE content = 'O''Reilly: "hello"' LIMIT 20;
SQL
```

交互只补缺失选择；必要参数齐全时直接执行。终端选择来自相同的 Service 声明和运行时发现，
不会另维护菜单。缺参时仅在可交互终端引导补齐；非 TTY 下缺参或目标歧义直接报错。
`--file -` 独占 stdin，不借 stdin 做交互。通用选择与录入机制归 terminal 层，目前由 db 接入，
不改变其它命令既有的交互策略。

`-e/--execute` 与 `--file` 互斥，文件是 UTF-8，最多一条语句。`--params` 是与 `?` 对应的 JSON
标量数组，使用协议绑定而不是字符串插值。SQL 文件避开 shell 转义，但不改变 SQL 自身引号规则。
字符串使用成对引号；反斜杠值通过绑定参数传递，以避免 parser 与服务器 SQL mode 对字符串边界的
理解不同。SQL 保留原文执行，不根据 AST 重新生成。

## 关键设计

### 只读是多层约束

MySQL AST 分类只允许 SELECT（包括 CTE、JOIN、聚合）和 EXPLAIN SELECT；锁定查询、SELECT INTO、
多语句、会话变量、可执行注释和 optimizer hint 被拒绝。函数采用保守允许清单，未知函数、存储函数、
UDF、文件读取与 sleep 不进入执行阶段。元数据操作由 Core 生成固定语句，不开放任意管理 SQL。

toolbox 在独占、一次性的原生 MySQL 会话内固定 SQL mode、设置 SELECT 执行期限并开启 READ ONLY
事务，再通过 prepared protocol 执行。整个作用域占用共享查询槽位，退出时销毁会话，避免事务状态
污染其它借用者。READ ONLY 不是任意 SQL 沙箱，仍要求最小权限账号，不建议使用管理员凭据。

需要支持 `max_execution_time` 的 MySQL（5.7.8+）；不将此支持范围扩展为 MariaDB 或其它数据库兼容承诺。
Pod Python 路径不支持有界只读接口时明确失败，不能退回完整缓冲查询。Metric 的既有 DB 直采仍只消费
envPrefix，自定义 source 的宏观检查使用 store。

### 限制在接收过程中生效

每次查询具有时间、保留行数和 JSON 行字节预算；收到超额行即停止保留并关闭连接，记录截断。
字节预算不包含 JSON 包装和列名，也不是单个数据库网络包/超大字段的内存硬上限。发现阶段也有预算，
因此巨大清单应通过 database/table 缩小范围。

客户端超时、取消和断开不等于已证明服务器立即终止计算。服务器 SELECT 期限是补充限制，不是所有
元数据操作的统一取消保证；失败不重放 SQL，不通过另一连接自动重试。

### 证据与展示分离

JSON、HTML、Bundle、Manifest 共用 Evidence 与根交付流程。取证记录目标来源、选择结果、执行时间、
缺失项和截断原因；连接密码不落盘，driver 原始错误不回显 SQL 或业务值。
SQL、绑定参数和结果保存在受限临时目录的原始证据中，可能包含敏感业务信息，应按取证数据管理。
`--show-databases` 在终端和报告显示数据源、说明、库名与发现状态；JSON 结果和 manifest 的目标信息
保留相同数据源元数据，AI 无需解析展示表格。其它操作输出状态与产物位置。Distribution 可通过已有 commandDefaults 设置
db 的 format，db 不另建发行版默认值机制。
