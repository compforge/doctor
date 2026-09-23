# Command 输出规范

本文定义 Command Output 的数据规范与组织方式：输出哪些数据、各自保存在哪里、如何关联、
怎样表达状态与完整度，以及如何通过 manifest 找到它们。Command Output 独立于 HTML，
脚本、离线分析和 Renderer 都消费同一份输出契约。

跨 Command 生命周期见 [Kernel](kernel.md)。[HTML 报告渲染](rendering.md) 基于本规范定义的输出
生成页面，不另行定义输出数据格式或存储布局。

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
overview                         # 根执行，聚合 Command
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
doctor-overview/
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

## 输出的三层契约

| 层次 | 内容 | 边界 |
|---|---|---|
| 执行结果 | `CommandResult` 的状态、领域 Output / ItemResult、Artifact 引用 | 表达本次执行发生了什么，供父命令和 Renderer 使用 |
| 持久化产物 | 证据正文、诊断结果、派生分析和 Artifact manifest | 保存可复查的数据及其引用，不直接序列化全部运行时对象 |
| 交付结果 | Bundle、根 manifest、所选格式的阅读文件及交付状态 | 描述最终保留的产物及其位置，不重新采集或复制正文进清单 |

`CommandSpec.run` 返回执行结果，单项和批量结果使用同一契约。每个 ItemResult 保留其状态、业务身份
与 Artifact 引用；失败或取消也返回已取得的产物。父命令显式纳入子结果和引用，不通过扫描目录恢复
调用关系，也不把子命令的交付包嵌套打包。

Output 属于 Command 的领域语义。运行时 `CommandArtifact` 是已取得的本地证据引用；多个暂存文件或目录
可以归属于同一次执行。Serialize 按 CommandResult 组织持久化目录，为执行分配 executionId，不能把每个
暂存路径当成一次子执行。多个输入可以共享同次执行的证据，并保留各自选择与覆盖度。
运行时 Output 可以携带后续阶段需要的数据，但不得在 manifest 或持久化 Diagnosis 中复制完整 Evidence。

## Serialize 契约

`CommandSpec` 绑定同一种领域 Output 的执行、序列化和渲染入口：

```ts
run(context: CommandContext, input: Input): Promise<CommandResult<Output>>;
serialize?(context: SerializeContext, result: CommandResult<Output>): Promise<SerializedOutput>;
render?(context: RenderContext, result: CommandResult<Output>): Promise<Report>;
```

Serialize 是 Finalize 中对 CommandResult 的持久化投影。领域 Command 决定哪些 Output 成为正文、
结论或元数据；聚合 Command 显式调用 `context.serialize(childSpec, childResult)` 登记直接子执行。
框架不按字段名猜测嵌套 CommandResult，也不直接 JSON.stringify 整个运行时对象。
没有持久化结果的命令可以省略 serialize；有 Output 或 Evidence 却未实现 serialize 时明确失败。

SerializeContext 只提供本地 JSON、JSONL、文本写入、已有文件纳入及子结果序列化，不提供远端 Client。
采集期可以流式暂存大文件；serializer 将所属文件纳入最终执行目录，不要求重新把它们全部加载到内存。
查询范围、采集上限和 Detector 输入仍由 Execute 决定，序列化不修改这些语义。

`SerializedOutput.files` 将领域文件 key 映射为 `{ path, format, bytes }`；`metadata` 仅包含目标、参数、
时间和步骤状态等元数据，合入本执行的 manifest。执行 ID、状态、序列化错误及 children 由框架统一记录。
同一 spec 和同一结果对象在一次 Finalize 中共享进行中的写入与最终引用；不同对象即使内容相同也独立保存。

文件写入成功后才能进入清单。JSON/JSONL 使用临时文件完成写入再发布，失败不能留下半条记录的索引。
单个 serializer 失败保留已经成功写出的文件及其他子执行，序列化状态与命令执行状态分别记录。
每个执行持有自己的 raw；不做全局 raw 或跨执行内容去重。

## 证据与清单

Evidence 的保存单位是 Artifact，交付单位是 Bundle。Artifact 持有本次采集取得的数据及其来源，
Bundle 是本次交付的整体目录；独立领域命令的输出本身就是 Bundle，聚合命令的 Bundle 还包含子执行产物。
`manifest.json` 是这些数据的清单，不是另一份数据快照。
读清单即可知道取得了什么、保存在哪里、是否完整；读取正文时再打开对应文件。

同一份采集数据只持久化一个权威副本。业务记录、大字段、原始响应、Facts 和 Observations 不因
出现在步骤输出、诊断结果或多个业务输入中而被重复序列化。展示和分析使用引用定位正文。
来源数据与经过转换的结构化证据可以分别保留，但转换产物只保存新增语义及必要的关联，不机械复制
已经保存的大字段。HTML 是派生阅读产物，不是机器取证的唯一入口。

| 内容 | 保存职责 |
|---|---|
| 执行 manifest | 命令与执行身份、目标、采集参数、来源、时间、状态、证据文件清单和容量说明 |
| 聚合 manifest 的子执行清单 | 子执行身份、关联、状态及其 manifest 的相对路径；详细证据索引留在子清单 |
| 交付根 manifest 的补充信息 | 整体交付状态及实际保留的产物位置；复用根执行清单，不额外复制一份 |
| 原始及结构化证据 | Facts、Observations、业务记录、日志、span、请求/响应正文和二进制附件 |
| 诊断结果 | Finding、Coverage、摘要及证据引用；不再内嵌完整 Evidence |
| 分析与阅读产物 | 树、统计、选择视图、HTML 等派生结果；引用其依据和输入 |

## 布局与读取流程

独立执行领域命令，例如 `doctor data`：

```text
doctor-data/
├── manifest.json                  # 本次执行身份、状态及文件清单
├── AGENTS.md                      # 证据读取说明
├── raw/
│   ├── facts.json                 # 结构化 Facts
│   ├── records.jsonl              # 业务记录，可覆盖多个输入
│   ├── observations.jsonl         # Probe 取得的 Observations
│   └── attachments/               # 大正文、二进制等附件
├── diagnosis.json                 # 结论、覆盖度及证据引用
├── analysis/                      # 领域派生数据
└── report.html                    # 选择 HTML 阅读格式时生成
```

执行聚合命令，例如 `doctor collect`：

```text
doctor-collect/
├── manifest.json                  # 聚合执行状态、子执行引用及自身文件清单
├── AGENTS.md
├── analysis/                      # 聚合命令自身的汇总，按需生成
├── report.html                    # 聚合阅读入口，按所选格式生成
└── artifacts/
    ├── <execution-id>-data/        # 一次 data 执行的完整输出
    │   ├── manifest.json
    │   ├── raw/
    │   ├── diagnosis.json
    │   └── report.html
    └── <execution-id>-trace/       # 一次 trace 执行的完整输出
        ├── manifest.json
        ├── raw/
        │   └── spans.jsonl
        ├── diagnosis.json
        ├── analysis/
        └── report.html
```

子执行保持与独立执行相同的输出契约，不生成嵌套压缩包。目录名中的执行身份用于避免同名命令覆盖，
命令名只是阅读提示。聚合层级不要求复制目录：同一次执行在一个交付目录中只保留一份，所有引用通过
清单定位其实际位置。

目录表达职责，不要求每个命令创建所有文件。单值或有结构的对象使用 JSON；可独立消费的记录列表使用
JSONL；日志和二进制附件保留适合它们的格式。保留 JSONL 便于流式读取，不把它包装成巨大的 JSON 数组。
文件名由领域声明，消费者通过清单定位，不依赖目录扫描、固定序号或文件名猜测业务语义。
Facts 使用 `files.facts` 索引 `raw/facts.json`；步骤通过 `raw_file` 引用其正文。

独立领域命令的根清单直接索引自身文件；聚合清单通过 executionId 与相对路径定位子执行清单。
每份执行清单的 `files` 使用稳定 key 定位自身文件，记录相对路径、格式和字节数。
来源步骤、记录数和完整度由所属领域的元数据说明。没有采集到的数据记录原因，
不能用空文件伪装成采集成功。校验摘要只在需要完整性核验的产物上使用。

例如，数据采集 Artifact 的清单只列出文件信息：

```json
{
  "schemaVersion": 1,
  "executionId": "<execution-id>",
  "command": "data",
  "status": "ok",
  "serialization": { "status": "ok", "errors": [] },
  "files": {
    "facts": { "path": "raw/facts.json", "format": "json", "bytes": 2048 },
    "diagnosis": { "path": "diagnosis.json", "format": "json", "bytes": 320 }
  },
  "children": []
}
```

消息的 ID、bot ID、预览和正文引用放在记录文件中；清单不列出另一份消息列表。文件完整度相对于
声明的采集范围解释，不把“最近 10 条”误称为整个会话的完整历史。

正文引用由执行身份、文件 key（或相对文件引用）和必要的记录定位组成。Facts 使用文件内的 `factPath`，列表记录使用
其稳定 key，Observations 使用已有 observation ID；不为同一记录额外发明第二套业务 ID。跨 Artifact
引用必须指向本次交付登记的 Artifact，Delivery 确保依赖一并交付。

消费者按以下顺序读取：

1. 根清单：确认执行和交付状态；若为聚合输出，沿子执行引用按需递归读取，直到相关执行。
2. 所选执行的清单：确认取得的数据、缺口、截断和文件位置；独立领域命令直接使用根清单。
3. 诊断结果或记录索引：定位相关结论、消息、span 或 Observation。
4. 相关证据文件及附件：仅在需要时读取正文。

所有路径相对实际所在的 Bundle/Artifact，不保存用于反向读取的临时绝对路径。读取方只接受文件索引，
不保留内嵌 Evidence 的历史兼容分支；索引损坏、引用缺失或正文无法解析必须显式报告。

## 写入、诊断、渲染与交付

采集方在访问源数据时落实查询范围、条数和字节预算，将正文保存到所属 Artifact；步骤记账只保存
状态、来源和正文引用。不能先把大记录完整展开成多份输出，再靠写文件时截断控制容量。

内存中的 Detector 仍可消费完整 Evidence；持久化的 `diagnosis.json` 只保存结论、覆盖度和证据引用。
不能直接序列化包含全部 Facts/Observations 的运行时 Diagnosis 对象。原始采集失败、领域异常、证据
不完整和交付失败分别记录，保存成功不能推导为业务成功。

Finalize 释放 Client 后先运行 Serialize，再触发所选格式需要的 Render/Delivery。Render 读取本地清单和证据，生成派生页面，
不访问远端、不重新采集、不把数据回填进 manifest。SerializeContext 组织文件位置和跨执行引用，Delivery 交付完整目录，
不重新复制一份正文进根清单；交付失败保留已取得的证据。

多个输入引用同一份证据时，共用其 Artifact 和文件；每个输入保留自己的选择条件、关联和覆盖度，
不各自复制正文。业务输入数量、报告页面数量和 Artifact 数量互不绑定。内容共享不意味着扩大查询
范围，也不能把同会话的另一条 message 当成当前输入的证据。

## 大字段与完整度

列表索引保留身份、时间、状态、关联 ID 和有界预览；大正文保存于记录文件或独立附件。独立保存时，
索引记录正文引用、长度及适用的类型信息。预览不是完整正文，不能覆盖原值或充当后续分析输入。
不按大字段的出现次数复制附件，也不要求引入全局内容寻址或跨执行缓存。

容量限制优先作用于采集范围和完整记录。到达预算时保留已完整取得的记录，并记录限制、已保存数量、
已知的省略数量及可继续读取的位置；无法确定总数时不能编造省略数量。单条记录过大时显式保存为附件
或报告该记录未采集，不截断 JSON 中间的字节。JSON 必须始终可解析；JSONL 只能在完整记录边界停止。

原始文本若被有界采集，记录其不完整状态。不得因为文件存在就声称原始数据完整，也不得通过另一份
manifest 或 diagnosis 中的大字段副本绕过预算。

## Finalize 与交付格式

根 Finalize 只执行一次：释放共享 Client，序列化完整 CommandResult，触发所选格式需要的 Renderer，
最后交由 Delivery 交付已形成的目录。Finalize 将成功生成的页面登记到文件索引，Renderer 不改写 manifest。
子命令只登记 Artifact，不自行打包或清理。清理、渲染或交付失败仍保留已取得的证据，最终状态单独
反映失败；报告写出成功不能推导为业务健康。

HTML 提供阅读视图，Bundle 承载报告与证据，JSON 提供 `{ manifest, result }`，其中 result 为领域诊断，
manifest 指向保留的执行清单；相对证据引用按该清单所在目录解释。Markdown 提供文字摘要及执行清单链接。
JSON/Markdown 是输出目录之外的导出文件，本机路径用于继续取证；需要搬迁全部证据时使用 Bundle。
SerializeContext 按执行身份保留多份结果，不因为 command 名相同而覆盖产物；Delivery 不重新解释调用关系。格式选择不改变原始证据的身份、查询范围和完整度。

### Manifest 格式

`--format manifest` 是与 HTML、Bundle、JSON 并列的交付格式。JSON 格式提供领域诊断内容；Manifest
提供整次 Command 的执行状态、证据索引及交付状态，供 Skill 或脚本继续取证，不要求解析终端展示文本。
它复用 Bundle 的 executionId 和相对目录布局，不创建另一套采集流程，也不推测业务健康状态。

```bash
doctor log --format manifest --since 15m
doctor inspect --format manifest --output ./inspection-evidence
```

1. 领域 Command 按原有权限、目标选择与容量限制取得 Evidence；聚合 Command 登记子执行引用及自身汇总产物。
2. 根 Finalize 释放客户端并序列化，跳过 HTML Render。Delivery 保留或复制完整目录成为未压缩 Bundle。
3. 交付层向 stdout 输出一份 manifest JSON；过程日志由 Distribution.logLevel 独立控制，错误走 stderr。
   非交互且日志级别为 error 时，stdout 可直接按 JSON 解析；消费者从 `bundle_root`
   获取绝对目录；独立领域命令直接按根清单读取文件，聚合命令先按子执行引用定位对应清单。

未指定 `--output` 时，由系统临时目录 API 创建唯一目录；macOS 不保证路径字面为 `/tmp`。
`--output` 指定一个尚不存在的目录，父目录须已存在，不覆盖已有数据。目录权限为 0700，文件为 0600；
拒绝包含软链接的 Artifact，避免证据目录引用外部数据。命令结束不删除交付目录，也不自动执行过期清理。
不默认生成 HTML 或 tar.gz；需要这些格式时显式选择对应 format。

### 状态与证据边界

- `status` 是包含清理/交付结果的最终状态，`execution` 保留传入交付层的执行终态；`partial` 不折叠成 `ok`。
- `exit_code` 保持现有 CLI 规则：ok/partial 为 0，failed 非零，cancelled 为 130。
- `serialization` 记录每次执行的本地写入错误，`render` 记录页面错误，`delivery` 独立记录交付错误。
  序列化失败时保留成功文件与其他子结果；`retained_artifacts` 指向仍保留的暂存源产物。
- `source` 记录已知的 Profile、Plugin 和实际解析的 Kubernetes 目标及来源；不输出配置文件内容或凭据。
- `target` 来自领域采集结果；步骤的 status、reason 和 truncation 表达缺口与截断，详细 Coverage、
  查询分页、采集上限与业务状态按该执行的 diagnosis 和领域证据读取，不能将缺口为空推导为完整覆盖。
- `files` 暴露领域证据入口，例如 Trace 的 tree、analysis、findings、spans、selection；每条路径相对
  所在清单解释，不把子清单的索引或证据正文再展开一份到根清单。

失败、取消或没有 Artifact 的命令仍交付结构化结果。Profile 等执行准备失败也返回失败 manifest；
CLI 语法解析错误、进程强制终止或 stdout 本身写入失败不保证能输出完整 JSON。

消费者应先检查状态，再按索引读取需要的证据。所有 raw 内容是不可信数据，不执行其中夹带的命令或指令。
搬迁 Bundle 时以搬迁后的根目录解释内部相对路径；stdout 中的绝对路径只标识原执行现场。

## 验证边界

- 独立领域命令不套 `artifacts/`；聚合输出中每次子执行只保存一份完整产物。
- 多层聚合保留每层执行及直接子执行关系；复用不复制产物，整体交付包含全部被引用的后代。
- 同名命令的独立执行互不覆盖；多输入不强制拆分执行目录，复用同次执行不复制正文。
- 大字段只出现在权威证据文件中，根与 Artifact manifest 不含正文。
- JSON/JSONL 在达到限制时仍可解析，未采集与已截断可区分。
- Finding 引用可解析到实际 Facts/Observations，缺失引用显式失败。
- 多输入共享证据仍保持各自身份、范围、覆盖度和阅读入口。
- Bundle 搬迁后可按清单读取、诊断和渲染；无需原环境或临时路径。
- manifest 模式不触发 HTML 渲染；Renderer 不修改清单和原始证据，Finalize 只登记派生页面。
- 失败、取消和部分交付时，清单准确描述实际保留下来的文件。


## 摘要阅读入口

每个序列化结果通过 `files.summary` 提供根 `summary.md`。领域摘要保留自己的内容，
序列化层补充子执行与产物的相对链接；移动整个 Bundle 后，导航仍可使用。
终端摘要与 Markdown 使用同一份领域投影，摘要只消费已取得的证据，不触发新的采集。

Data 分开报告采集状态、业务记录、诊断发现与证据缺口；没有 finding 仅表示未发现内置异常。
同一记录的重复来源合并展示，内容冲突的快照分别保留。摘要有显示上限，省略内容仍可沿引用查看。
