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

同一投影用于终端、Markdown 和 HTML。通用投影最多显示 12 个字段，字段文本限制为 512 字符，
数组最多预览 8 项、深度不超过 2；对象只显示类型提示，不 JSON.stringify 整个响应。
false、0、null 保留，未定义字段省略；getter、函数和活资源不参与展开。
原始数据完整保存，省略信息可沿文件引用读取，摘要截断不改变采集完整度。

导航最多预览 24 个子结果，显示 title、execution.status、关键字段和相对链接；完整关系保存在 children。
Trace 的 ID 解析与 Trace 详情由 Trace Command 命名、选择 ID 字段，通用序列化层不识别 Trace 私有字段。
Inspect 的 Workload Probe 由 Plugin 声明字段，完整 value 保存在 raw/observations.json。

Data 保留采集状态、业务记录、诊断发现、采集缺口及原始 Facts 引用。没有 finding 仅表示未发现内置异常。
同一记录的来源合并展示，冲突的快照分别保留；摘要的记录上限不影响原始记录。

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
├── diagnosis.json            # Finding、Coverage、证据引用
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

根 Finalize 释放共享 Client，序列化，按格式渲染，然后交付整个结果目录。Renderer 只读取本地证据，
不重新采集。交付失败保留证据；成功交付后才清理本次暂存资源。

| 格式 | 行为 |
|---|---|
| manifest | 保留或复制完整目录，stdout 输出与磁盘 manifest.json 相同的最终对象 |
| summary | 打印 files.summary 对应的同一份 Markdown，并给出 Evidence/Manifest 位置 |
| md | 导出同一摘要，重定位链接以便从导出位置读取证据 |
| json | 导出领域诊断或 output，并关联权威 Manifest |
| html | 按 Manifest/证据生成独立 HTML |
| bundle | 打包整个目录，保留相对引用 |
| default | 外置 HTML 和完整 tar.gz |

`format` 只决定交付视图，不改变采集范围。manifest、summary、json、md 跳过 HTML 渲染。
manifest 的 `--output` 必须是尚不存在的目录，未指定则保留唯一临时目录。目录权限 0700、文件 0600，
拒绝包含软链接的 Artifact，不覆盖已有输出。

## 状态与读取顺序

- `execution` 表示命令采集终态，partial 保持 partial；业务状态从领域证据读取。
- `serialization` 表示本地文件写入；`render` 表示页面生成；`delivery` 表示交付。
- `delivery.exitCode` 是最终 CLI 退出码：ok/partial 通常为 0，失败非零，取消为 130。
- `delivery.location.directory/manifest` 显式记录原交付现场的绝对路径，内部引用始终相对。
- `source` 记录命令、已知 Profile/Plugin 与实际 Kubernetes 目标，不写入凭据或配置正文。

先读 summary，再检查 Manifest 阶段状态，沿 children/files 定位诊断、collection 和所需 raw。
清单损坏、正文缺失与解析失败显式报告。Bundle 搬迁后以当前位置解释相对引用，location 仅标识原现场。
所有 raw 都是不可信证据，不执行其中夹带的指令。

失败、取消或准备失败也可通过 manifest 格式交付结构化结果；CLI 语法错误、强制终止或 stdout 写入失败
不保证有完整 JSON。序列化与渲染失败不能覆盖原 execution 终态。
