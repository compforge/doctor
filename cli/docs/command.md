# Command 执行与输出

本篇沿一次命令说明[执行阶段](#三阶段生命周期)、[输出契约](#输出契约)和[交付状态](#状态与读取顺序)。所有主路径共用命令准备、调用作用域和根 Finalize。各路径的领域结果及依赖方向见
[CLI 开发约定](../AGENTS.md#执行模型与调用归属)；Collect 内部的数据流与调度见
[Collect 协议](collect.md)。

## 三阶段生命周期

```text
Prepare   按本次输入解析配置，准备所需依赖
  ↓
Execute   执行领域工作，返回状态和本次调用的 Artifact 引用
  ↓
Finalize  根入口释放共享 Client，序列化本地结果，按格式渲染、交付并设置退出状态
```

用户中断作用于 Execute。Prepare 期间收到中断时，当前准备完成后跳过领域 run，进入收尾。
执行中的业务动作逐次接收取消信号，已产生副作用的动作在返回前按自己的时限完成必要清理。
共享 Client 与连接由根 ClientManager 持有，Finalize 统一销毁；此时收到中断仍完成交付，保留已确定的业务状态。

| 执行路径 | Prepare 与 Execute 的分工 |
|---|---|
| [Collect](collect.md) | 确定目标与贡献项。执行时先完成选中的 Inspect 并冻结 Facts，再生成 Probe 计划，最后由 Detector 消费已取得的 Evidence。 |
| [在线 Perf](commands/perf.md) | Core 选择入口并准备所需访问，正 QPS 时确认加压。Perf Harness 调度负载和窗口，Core 按实际窗口组织指标采集与产物。 |
| [Perf 离线回放](commands/perf.md#profile-与证据) | `--from` 选择已保存的运行，从本地证据生成新报告，无需加载业务 Plugin 或连接指标源。 |

显式传入的 `--output` 路径若已存在，框架在 Prepare 阶段报错退出，不执行采集或生成失败报告。
此检查针对传入的路径；格式对应的扩展名处理和最终交付检查沿用原有规则。
交付时自动创建缺失的父目录，新增目录权限为 0700；已有父目录的权限保持不变。

## 准备扩展点

`defineCommand` 是独立命令和聚合子命令共用的调用入口。每个 CommandSpec 必须提供 prepare 和 run；
入口先校验输入，再调用 prepare，将其类型化结果传给领域 run。调用者通过封装后的 Command.run 传入
原始 Input，准备结果由命令内部持有。

每个命令的 `prepare` 都负责明确、汇总本次调用在执行前可以确定的配置。它复用宿主已解析的值，按[配置优先级](configuration.md)处理命令自己的输入，把有效配置和已绑定的依赖一并放入 `Prepared`。领域 `run` 直接使用这些值。
依赖现场证据的选项可在取得证据后、执行相关动作前确定。交互时展示当前建议值，用户明确输入的值优先，回车采用显示的默认值。

`prepare` 同时按输入选择本次依赖，完成 Plugin 能力存在性检查、环境准备和已选实现的声明绑定。
公共的能力与环境检查复用 prepareCommandRequirements；没有额外准备工作的命令直接返回输入。
依赖 Extension 声明的请求身份也由 prepare 补齐：按需发现目录、应用参数与配置优先级，并通过共享 Decision 完成交互选择。
准备结果向 run 传递已解析的依赖与输入，不让执行中的每个实例重复询问。
validate 负责不访问外部资源的输入校验，在加载 Plugin 和访问环境前拒绝无效请求。

init/profile 等启动命令不要求已有 Profile。

prepare 根据本次输入选择并绑定资源和能力，Service 则提供 Workload、DataSource、capability 与 access
声明及实现。Service 不接收 Command DTO，也不根据命令名切换业务行为。内置工作和 Service contribution
通过相同的执行契约进入系列引擎；Plugin 适配层保留来源、受限上下文与结果校验。

准备结果属于命令内部，可以包含运行时 handle，不要求可序列化。prepare 与 run 处于同一个调用资源
作用域和幂等复用单元：准备失败时保留已登记产物并释放局部资源；prepare 返回 undefined 表示取消，
中止本轮且不进入 run。共享客户端仍由根 Finalize 回收。准备期间的外部访问同样必须先检查 access；
需要作为 Evidence 留存的现场获取结果继续通过 Inspect 等取证流程处理。

Plugin 的每次 Kubernetes 操作都先检查所属 capability 的 access 声明，再由目标 API 判权；不在调用前
汇总预检所有候选路径。Core 自身的权限诊断与用户审批仍按具体命令执行。
聚合命令准备自身依赖，子命令在被调用时独立准备，以保留逐项失败隔离和部分完成结果。

Execute 的内部流程由命令系列决定；Collect 使用 Inspect → Probe → Detector，Provision 等系列保留
自身领域流程。Finalize 统一消费 CommandResult，通过 serialize/render 完成本地持久化与交付。

## Service 选择

业务 Service 选择统一使用可重复的 `-s, --service <name>`，例如 `-s api -s worker`。
Command 输入使用 `services: string[]`，一个 Service 也是长度为 1 的数组；不使用逗号字符串或
另设 `--services`。省略选择沿用各命令的默认范围，显式选择按 Catalog 解析别名并去重。
原本逐目标执行的 DB、S3、Store、Eval、Perf 复用 Command 准备、执行和结果组合协议逐服务运行；
每个 Service 保留独立结果和证据，失败不丢弃其它服务结果，取消停止后续执行。


## CommandSpec 与执行入口

每个常规命令提供 `CommandSpec<Input, Output>`，普通命令和组合命令共用
`run(context, input): Promise<CommandResult<Output>>`。CLI 将 flags 转为领域 Input；父命令直接调用
子命令的同一入口。`defineCommand` 包装校验、环境准备、取消与资源收尾，因此嵌套调用仍需满足自身
的 capability 和 access 前提。

根入口只解析一次 Profile，选定的 Plugin 及其配置校验在整轮内复用。每次调用按顺序执行：

```text
validate domain input
  → required Plugin capability + validated Plugin config
  → declared Host / Kubernetes environment
  → selected Target + scoped capability declarations
  → domain work or child Command.run calls
  → invocation result + resource cleanup
```

组合命令逐个调用已选择的子命令；一个子命令不可用时，其它独立子命令仍可执行。子命令的必要条件
不能简单合并成父命令的全局门槛，否则缺少一种证据能力就会阻断整个概览或采集。

Input 可以提供 `idempotencyKey(): string`，显式声明本次逻辑执行的身份。`defineCommand` 在输入校验后，
按 Command 定义身份和 key 在当前 CommandContext 中合并调用：正在执行时等待同一个 Promise，包括资源
清理；已完成时返回原状态、Output 和 Artifacts，不产生 skipped 状态。未提供方法时每次独立
执行。完成结果包括 partial 和 failed，本轮不隐式重试；取消始终优先于复用。key 必须包含会改变结果的
领域参数，Profile、Plugin 和宿主配置由当前 Context 隔离，记录不跨 Doctor 运行保留。

Inspect 和 Tenant 的 Input 构造函数按检查范围、租户及采集参数生成 key，Collect 使用这些 Input 调用
子命令。调用方仍显式纳入子产物，Artifacts 按产物 ID 去重，因此多个 Collect 可引用同一份环境/租户证据，
最终报告只交付一份。Overview 无需识别第一次或后续 Collect。

## DoctorError

`DoctorError` 是 Core 和 Plugin 共用的错误基类，承载面向读者的 `message`、可选的稳定诊断码
`code` 和原始 `cause`。`CommandError` 继承它，并在首次经过 Command 边界时记录 `command`。
父命令透传错误时保留这个名称。诊断的 `command` 表示错误来源，`target` 标识生成该条诊断的作用域。
[基类定义](../../packages/plugin/src/errors.ts) · [Command 错误类型](../src/command/result.ts)

| 错误类型 | 使用场景 | Command 行为 |
|---|---|---|
| `DoctorError` | 当前操作失败，可附带诊断码和底层原因 | 未在当前步骤处理的错误会形成该次调用的 `failed`。聚合命令可以继续执行独立步骤。 |
| `CommandError` | Command 层的一般失败 | 记录来源命令。以下两个子类分别表达输入错误和整轮终止。 |
| `CommandInputError` | 参数或输入组合无效 | 诊断码为 `invalid_argument`。作为根命令失败交付时，CLI 退出码为 `2`。 |
| `CommandAbortError` | 当前目标已确定无法继续执行整轮命令 | 子命令逐层向上抛出，最外层 `Command.run` 收敛为 `failed`，停止后续步骤。CLI 输出一次错误提示，退出码为 `1`。 |

领域代码捕获并降级错误时，须透传收到的 `CommandAbortError`。例如，`collect` 确认交互选中的
namespace 匹配到零个插件 Service 时，抛出诊断码为 `namespace_no_matching_services` 的
`CommandAbortError`，提示指定业务 Service 所在的 namespace 后重试。

最外层 Command 进入 Finalize，清理资源并交付已保留的产物；执行诊断写入 `diagnostics.json`，
其中包含脱敏后的消息、诊断码及原因链。根命令的普通失败退出码为 `1`。用户取消以 `cancelled`
交付，退出码为 `130`。 [执行诊断](../src/command/diagnostic.ts) · [退出码映射](../src/app/command.ts)

## Context 与调用归属

`CommandContext` 属于整轮执行树，保存 Profile、当前 Plugin、按需准备并复用的环境信息、权限检查、
Decision、ExecutionRecord、共享 ClientManager 与取消信号。领域 Context 保存单次执行准备的 Target、client、
Bundle 和领域状态；PluginContext 只暴露本次 Service 调用所需的受限依赖与 infra。

同一 CommandContext 可以被并发子命令共享。Artifacts 使用异步调用作用域，每次调用返回自己的产物
引用，父命令显式选择并纳入子产物；不能按全局列表位置或命令名猜测产物属于哪次调用。
领域输入与输出通过 Input / Output 传递，不放入共享 Context。

报告命名由根命令的 `CommandSpec.reportName(input, result, now)` 在 finalize 交付时推导；run 与
子命令结果不携带报告名称。hook 可从离线结果提取业务 ID，也要处理失败或取消时缺少 Output 的情况；
未提供名称时使用带时间戳的命令名，显式 `--output` 仍由 delivery 处理。

Artifact ID 标识一份具体产物，command 幂等 key 标识一次可复用执行，两者职责独立。CommandArtifacts
统一使用 add 登记或添加引用：首次登记由 Core 分配 ID，同一本轮内重复登记规范化源路径返回原引用；
已携带 ID 时保留身份，并校验其 command 与来源路径一致。父命令添加子结果不会重新分配 ID，幂等返回的
结果自然引用原产物。文件名和时间戳只用于阅读，不能承担产物唯一性。

Host 创建的 PluginContext 继承当前调用的取消信号，并登记到本次调用的资源作用域。显式 dispose
和执行层兜底清理共用一次回收；子调用只关闭自己的资源，不关闭父调用的资源。用户取消会传播到整轮
执行树，停止后续工作，并保留已生成证据。


共享 Client 的身份、初始化与销毁顺序见 [数据源生命周期](datasource.md)。直接嵌入 CommandSpec 的
宿主也负责在整棵调用树结束后调用根 Context 的 `disposeClients`；CLI 在 Finalize 统一完成。

## 结果与交付

run、serialize 和 render 绑定到同一领域 Output；父命令显式组合子结果与子报告。
脚本、离线分析和 Renderer 都从同一份输出读取结果。页面组织见 [Report](report.md)。

## 领域 Command 与聚合 Command

按输出职责区分两类 Command：

| 类型 | 职责 | 示例 | 输出组织 |
|---|---|---|---|
| 领域 Command | 直接完成某一领域的采集、诊断或分析 | `data`、`trace`、`inspect` | 本次执行的清单、证据和诊断直接放在输出根目录 |
| 聚合 Command | 编排其他 Command，关联子结果并形成汇总 | `collect`、`overview` | 清单登记子执行，交付根的 `artifacts/` 保存各次后代执行的产物 |

使用“领域”而不是“原子”，因为一次领域命令可以查询多个 Service、处理多个业务 ID，或执行多个步骤，
并不意味着操作不可拆分或具有事务原子性。这里区分的是输出职责，不按内部函数调用次数分类。
聚合命令也可以产生自己的汇总或分析，保存在自身输出中，通过引用关联子证据，不复制子证据正文。

**产物目录的粒度是一次 Command 执行。** 一次 `data` 查询多个 conversation，仍保存一份执行输出，
在数据和结果中记录各输入的关联、状态与覆盖度。同一个命令独立执行两次，保存两份输出；多个聚合结果
复用同一次执行时，引用同一份输出。不能仅凭命令名、业务 ID 或内容相同就把独立执行合并。

`artifacts/` 用于组织聚合命令引用的子执行输出，不是所有命令都必须套的一层目录。
一份输出可以包含多个证据文件、附件和阅读页面；“一份”指完整的执行产物，不是一个文件。

### 聚合命令可以递归组合

聚合 Command 的子命令可以是领域 Command，也可以是另一个聚合 Command。“根命令 / 子命令”描述
本次调用的位置，“领域 / 聚合”描述输出职责，两者是独立维度。例如：

```text
overview                        # 根执行，聚合 Command
└── collect                      # 子执行，同时也是聚合 Command
    ├── trace                    # 领域 Command
    ├── log                      # 领域 Command
    └── data                     # 领域 Command
```

每次执行都有自己的身份和 manifest。每个聚合节点登记直接子执行的引用，保留自身输入、状态及汇总；
即使只做编排、没有 raw 文件，也保留该节点。`overview` 引用 `collect`，`collect` 再引用
`trace`、`log`、`data`，不能将后代全部改记成 `overview` 的直接子执行而丢失编排关系。

执行关系通过清单递归表达，物理目录在交付根的 `artifacts/` 中统一组织，避免层层复制子树：

```text
doctor-overview-<window>/
├── manifest.json                # overview：引用 collect
├── analysis/                    # overview 自身的汇总
└── artifacts/
    ├── <id>-collect/
    │   └── manifest.json        # collect：引用 trace、log、data
    ├── <id>-trace/
    │   ├── manifest.json
    │   └── raw/
    ├── <id>-log/
    │   ├── manifest.json
    │   └── raw/
    └── <id>-data/
        ├── manifest.json
        └── raw/
```

每份清单中的路径相对该清单所在目录解释；子执行引用可以指向同一 Bundle 内的兄弟目录。
SerializeContext 负责映射路径，Delivery 交付整个序列化目录，包含全部被引用的后代产物。
同一次执行被多个聚合节点复用时保留多处引用、只保存一份产物，此时引用关系是无环图。
只有最外层命令执行 Finalize 和整体交付，中间聚合层不另行打包或清理共享资源。

## 输出契约

执行返回 `CommandResult<Output>`：执行状态、领域 output、显式 Artifacts 和可选 `summary: Summary`。
摘要字段路径相对 output；Command 自己选择和组合 Extension 结果，不增加 `CommandSpec.summary()` 回调。

序列化由 `CommandSpec.serialize(context, result)` 与 `SerializeContext` 完成。serializer 只读取本地结果，
登记文件和直接子结果；相同 spec 与结果对象只序列化一次。没有领域 serializer 的简单命令可以通过
`CommandResult.summary` 使用通用 output.json 序列化。没有自定义摘要、失败或取消时，Core 保留基本状态摘要。

`Summary` 的公共接口、Extension 信封与资源边界见 [Extension](extension.md)。Fact 的 summary 相对 value/record，
Workload Observation 的 summary 相对 value。字段语义由生产者声明，Core 不猜测业务状态或响应体结构。

## 统一 Manifest

根执行和可导航的 Artifact 共用 [Manifest](../src/command/manifest.ts)，schemaVersion 为 2。

```ts
interface Manifest {
  schemaVersion: 2;
  kind: "command" | "artifact";
  id: string;
  title: string;
  source: { command: string; profile?: string; plugin?: string; targets?: readonly unknown[] };
  execution: { status: CommandStatus; reason?: string };
  serialization: { status: "ok" | "failed"; errors: readonly string[] };
  files: Readonly<Record<string, { path: string; format: string; bytes: number }>>;
  children: readonly { id: string; manifest: string }[];
  // 根 Finalize 按实际阶段补充 render、delivery。
}
```

Manifest 保存身份、状态和索引。领域目标、查询参数、采集步骤和时间线存入 `collection.json`，
由 `files.collection` 引用；事实和响应正文分别在 raw 中。Extension 返回值不生成磁盘 Manifest。
采集阶段可暂存文件和 collection，只有统一序列化层创建导航清单。

独立命令的一份 Artifact 直接纳入执行目录；多个 Artifact 放入 `items/<id>/`，每项拥有统一的
Artifact Manifest。聚合命令通过 `children` 引用子执行，后代执行物理目录放在交付根的 `artifacts/` 中。
每条 files/children 路径相对其所在 Manifest，搬迁整个 Bundle 后仍可解析。

文件写入完成后才能进入索引。JSON/JSONL 原子写入；序列化失败保留已经取得的文件和其它子结果。
File descriptors 记录实际字节数。清单不展开子清单正文，也不重复存放业务记录或原始响应。

## 摘要与原始证据

每个序列化结果有稳定的 `files.summary`，指向 `summary.md`。有声明式摘要时，`summary.json`
保存 Summary 与数据文件绑定，`summary-projection.json` 保存有界阅读投影。Command 默认绑定 output.json；
Artifact serializer 显式绑定该项数据文件。摘要规范不要求插件返回 Markdown 或 HTML。

同一投影用于终端、Markdown 和 HTML，按标题、生产者提供的 `text`、字段顺序展示。
`text` 是纯文本，展示时转义并限制为 512 字符；完整文本保存在摘要声明或原始 Fact 中。
通用投影最多显示 12 个字段，字段文本限制为 512 字符，
数组最多预览 8 项、深度不超过 2；对象只显示类型提示，不 JSON.stringify 整个响应。
false、0、null 保留，未定义字段省略；getter、函数和活资源不参与展开。
原始数据完整保存，省略信息可沿文件引用读取，摘要截断不改变采集完整度。

导航最多预览 24 个子结果，显示 title、execution.status、关键字段和相对链接；完整关系保存在 children。
Trace 的 ID 解析与 Trace 详情由 Trace Command 命名、选择 ID 字段，通用序列化层不识别 Trace 私有字段。
Inspect 的 Workload Probe 由 Plugin 声明字段，完整 value 保存在 raw/observations.json。

Data 保留采集状态、业务记录、诊断发现、采集缺口及原始 Facts 引用。没有 finding 仅表示未发现内置异常。
同一记录的来源合并展示，冲突的快照分别保留；摘要的记录上限不影响原始记录。
Data 为父级导航提供最多六条带生产者文本的记录及 Facts 位置；Log 等组合命令直接展示这些关键事实，
通过同一导航中的 Facts 文件链接查阅对应记录。

## 正文与容量边界

```text
result/
├── manifest.json             # 统一身份、阶段状态、文件/子结果索引
├── summary.md                # 首次阅读入口
├── summary.json              # 按需生成的摘要声明与数据绑定
├── summary-projection.json   # 有界字段投影
├── collection.json           # 目标、参数、步骤及时间线
├── raw/
│   ├── facts.json
│   └── observations.json
├── diagnosis.json            # Finding、证据引用
├── items/                    # 同一次执行的多个 Artifact
├── artifacts/                # 被聚合的 Command 执行
└── report.html               # 按所选格式生成
```

布局按需生成，读取方通过 files key 定位文件。业务记录以稳定 key、Observation ID 或 factPath 定位，
不发明额外业务身份。跨 Artifact 引用必须指向本次交付登记的证据。

采集方在读取源数据时落实查询和容量预算。JSON 保持可解析，JSONL 在完整记录边界停止，
截断与缺失明确记录；预览不能覆盖原值。Detector 在运行时可消费完整 Evidence，持久化 diagnosis
只保存结论与证据引用。文件保存成功不表示业务成功，采集完整度相对声明的范围解释。

## Finalize 与格式

根 Finalize 只执行一次：释放共享 Client，调用根 serialize，按格式渲染，然后交付整个结果目录。
SerializeContext 和 RenderContext 只允许本地操作，不重新取得远端 Client 或执行采集。
同一 spec 的同一结果对象在本轮内共享序列化与渲染；独立结果即使内容相同也保留各自身份。
清理、序列化或渲染失败仍保留可用证据，阶段错误与原执行状态分别记录，取消优先返回 130。
成功交付后才清理本次暂存资源。

SerializeContext 分配执行目录与清单引用；HTML 生成器消费显式 Report，不按目录名猜测导航或反解析
子 HTML。Delivery 交付已序列化的目录及阅读文件，不重建调用关系。报告名称由根 CommandSpec 的
`reportName(input, result, now)` 推导；具体命名与 Artifact 身份见 [调用归属](#context-与调用归属)。

| 格式 | 行为 |
|---|---|
| manifest | 保留或复制完整目录，stdout 输出与磁盘 manifest.json 相同的最终对象 |
| summary | 仅展示结果、状态和必要缺口，不打印证据导航或 Evidence/Manifest 路径 |
| md | 导出同一摘要，重定位链接以便从导出位置读取证据 |
| json | 导出领域诊断或 output，并关联权威 Manifest |
| html | 按 Manifest/证据生成独立 HTML |
| bundle | 打包整个目录，保留相对引用 |
| default | 外置 HTML 和完整 tar.gz |

HTML 优先服务人阅读，突出关键结果、状态和证据缺口，按需展开明细。`tar.gz` 优先保证证据完整，
在声明的采集范围与预算内保留原始数据、来源、失败原因和缺失记录，供排查、复核和离线分析。
HTML 可以省略归档中的明细。

所有 Command 的 `summary` 格式都在公共 CLI action 入口将过程日志级别收敛到 warn，
覆盖独立离线命令以及诊断命令的准备、执行和清理；直接/嵌入调用共享同一策略。
发行版已有的 error 级别仍保留。结果通过独立 writer 输出，不受日志级别影响。

`format` 决定终端呈现，既控制执行阶段的日志，也控制 finish 阶段的输出。
finish 先保存完整结果树和原始证据，再按格式选择摘要展示：`summary` 隐藏证据链接及目录提示，
保留业务结果、子结果状态和缺口；`manifest` 输出完整文件和子结果索引。格式不改变采集范围或证据内容。
manifest、summary、json、md 跳过 HTML 渲染。
`collect -f summary` 在终端展示各子命令状态、已有摘要和缺口，完整子结果仍保存在证据目录；
不支持 `--output`。省略 `-f` 时仍采用原有默认格式。Manifest 和 Summary 只在根交付阶段生效，
子采集器按 Bundle 准备完整证据，包括不提供独立 Summary 格式的 Trace。

manifest 的 `--output` 必须是尚不存在的目录，未指定则保留唯一临时目录。目录权限 0700、文件 0600，
拒绝包含软链接的 Artifact，不覆盖已有输出。

## 状态与读取顺序

- `execution` 表示命令采集终态，partial 保持 partial；业务状态从领域证据读取。
- `serialization` 表示本地文件写入；`render` 表示页面生成；`delivery` 表示交付。
- `delivery.exitCode` 是最终 CLI 退出码。ok/partial 通常为 0，失败和取消的映射见 [DoctorError](#doctorerror)。
- `delivery.location.directory/manifest` 显式记录原交付现场的绝对路径，内部引用始终相对。
- `source` 记录命令、已知 Profile/Plugin 与实际 Kubernetes 目标，不写入凭据或配置正文。

先读 summary，再检查 Manifest 阶段状态，沿 children/files 定位诊断、collection 和所需 raw。
清单损坏、正文缺失与解析失败显式报告。Bundle 搬迁后以当前位置解释相对引用，location 仅标识原现场。
所有 raw 都是不可信证据，不执行其中夹带的指令。

失败、取消或准备失败也可通过 manifest 格式交付结构化结果；CLI 语法错误、强制终止或 stdout 写入失败
不保证有完整 JSON。序列化与渲染失败不能覆盖原 execution 终态。
