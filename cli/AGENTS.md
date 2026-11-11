# cli AGENTS.md

## 项目定位与边界

Doctor CLI 是本地诊断入口，以 Provision、Health、Overview、Collect、Eval、Perf 和 Chat 七条并列主路径组织能力准备、
体检、概览、确定性诊断、数据集采集、主动施压和开放式问答；具体业务目标、私有数据位置和数据语义由外部 Plugin 提供。
使用主线是部署后的 Health、运行后的 Overview、问题发生后的 Collect 与专项命令，见
[排查主线](../AGENTS.md#排查主线)。

- **离线知识**：`doctor knowledge` 组织 Plugin/Service 的概念、流程、文章与词典，不准备 Target 访问。
- **配置与入口**：`doctor init/profile` 管理本地 profile，bare `doctor` 展示当前能力索引。
- **能力准备**：`doctor image/debug/install/resize` 显式改变 Registry、Doctor Host 或 Target 状态。
- **确定性诊断**：各领域命令共用 Collect、Evidence 和风险授权协议，不依赖具体业务实现。
- **计算资源概览**：`doctor compute` 分别展示集群容量与 Service Workload 占用；权限不足保留覆盖缺口，不作为健康故障。
- **系统体检**：`doctor health` 按 Service 执行 self/deps Probe 与 biz Case，默认全选支持体检的服务，不查询代表 biz-id 或触发 Collect。
- **运行概览**：`doctor overview` 展示历史统计和耗时分布，按需从可下钻条目选取 biz-id，确认后复用 Collect。
- **数据集采集**：`doctor eval` 从统一 Case 目录选择 CaseSet，逐例触发并复用 Collect 取得关联证据，不做质量评分。
- **Case 与主动施压**：`doctor case` 列出并发送选中的 HTTP Case；`doctor model` 和 `doctor perf` 从同一目录选择适用的 Case，Perf 复用共享 Harness 发压并采集同窗口证据。
- **开放式问答**：`doctor chat` 默认运行本地 Agent；显式 `--server` 才连接远端，两者共用 AgentUE/chat-tui 交互。
- **Extension 扩展**：Core、Plugin、Service 和本地适配器共用按 kind 发现的注册机制；公共契约归 `../packages/plugin`。

## 代码地图与核心模块

```text
cli/src/
├── app/                 Prepare / Execute / Finalize composition root
├── report/              Report、RenderContext、单文件阅读容器
├── command/             CommandContext、Target、access 与审批契约
├── collect/
│   ├── protocol.ts      Fact、Observation、Finding 共享协议
│   ├── evidence-identity.ts  Fact/Observation/Finding schema identity 运行时校验
│   ├── engine.ts        runCollect：Inspect → Probe → Evidence → Detector
│   ├── inspect-engine.ts  Inspect 依赖调度与 Facts 冻结
│   ├── probe-engine.ts  Probe 依赖、安全顺序与失败隔离
│   ├── detector-engine.ts  Core/Plugin Detector 执行与 Finding 契约校验
│   ├── evidence.ts      Worksheet 与 Evidence Bundle
│   ├── operation.ts     副作用授权与审计
│   ├── output/          通用格式与交付原语
│   └── <domain>/        领域 Config、Inspect、Probe、Detector、Renderer
├── provision/           image、debug environment、工具准备及实例资源调整
├── eval/                Case 顺序执行与关联证据编排
├── health/              Service self/deps/biz 主动巡检
├── overview/            历史统计、采样与按需 Collect
├── compute/             集群容量与 Service Workload 占用
├── resource/            Service Resource 只读盘点
├── knowledge/           离线知识目录
├── case/                共享 Case 目录、身份与单请求执行
├── datasource/          Service 数据源访问装配
├── perf/                受控负载与跨数据面证据编排
├── chat/                Session / Controller 与 AgentUE adapter
├── plugin/              Plugin 宿主选择、加载与公共协议适配
├── model/               Model Collect 与 Chat 共用的模型访问
├── terminal/            选择、确认与输出边界
├── protocol/            可选远端协议 client
└── infra/               Host、Target、Kubernetes 与外部资源 adapter

packages/plugin/         Plugin、Service、capability 与 Inspect/Probe/Detector contribution 公共协议
packages/agent/          CLI/server 共用的 Agent runtime
plugins/<plugin>/        具体 Service 实现、固定查询与 Skills
toolkit/                 独立版本的诊断工具和平台资源
```

依赖方向保持：

```text
cli/collect → packages/plugin ← plugins/<plugin>
app → command / collect / provision / eval / perf / chat / infra
collect/<domain> → collect shared protocol + infra ports
```

公共协议和调度只有出现跨领域稳定、同语义的重复时才上提；领域数据语义、固定查询、Renderer 和具体
Failure/证据不足 Finding 解释继续留在 `collect/<domain>`。`packages/plugin` 不依赖 CLI，具体 Plugin 不反向依赖
CLI 实现。

## 执行模型与调用归属

Core 统一驱动 `Prepare → Execute → Finalize`。Prepare 校验输入、解析有效配置和目标、选择并绑定
已声明能力；Collect 的 Execute 固定沿 `Inspect → 冻结 Facts → Probe → Evidence → Detector` 推进。
所有领域 Collect 通过 `runCollect` 或 `runCollectBatch` 进入共享引擎，不能直接调用低层 runner。
Finalize 在根入口释放 Client、序列化本地结果、按需渲染并交付，子命令不单独交付或设置进程退出码。

每个常规命令提供 `CommandSpec`；独立命令和聚合子命令共用 `Command.run(context, input)`，各自完成
prepare 和 run。组合命令保留逐项失败隔离，不能把所有子命令的必要条件合并为全局门槛。
Service 只声明和实现能力，不接收 Command DTO，也不按命令名切换业务行为。

`CommandContext` 属于整轮执行树，持有 Profile、Plugin、Environment、Decision、ExecutionRecord、
共享 ClientManager 与取消信号；领域 Context 持有单次调用的 Target、Bundle 和运行状态；
PluginContext 只暴露所选 Service 的受限依赖。领域 Input / Output 不放进通用 Context。
每次调用只返回自己的 Artifact 引用，父命令显式纳入子结果；Artifact ID、执行幂等 key 和文件名职责不同。
共享客户端由根回收，局部资源由其调用回收，取消传播到整轮并保留已生成证据。

`ok / partial / failed / cancelled` 表达执行完成度，Finding 表达证据支持的诊断判断；证据覆盖、
Target 健康和产物交付分别记录。partial 保留已有结果，不把现场缺口当作正常，也不把 Core 契约错误伪装成 partial。
执行幂等只在同一根 Context 内复用，包含 partial/failed，不能隐式重试或跨轮复用现场结果。

新能力先确定所在主路径和 owner，再定义领域 Input / Output；新增 Collect 先定义 Facts、Observations、
Evidence、Findings 和纯 Detector，再实现 Inspect、Probe 与 Renderer。按涉及的边界验证依赖调度、
能力降级、授权拒绝、敏感信息和交付结果。详细机制见下方 topic 文档。

## 关键约定

1. **执行位置属于能力身份**：Doctor Host 承载 CLI 和本地能力，Target 是被诊断对象；非只读动作必须
   在执行前展示位置、对象、真实动作和影响。
2. **Provision 与 Collect 按结果分离**：Provision 的结果是外部状态变化或能力准备；Collect 的结果是
   Evidence，不能演变成隐藏式发布、环境创建或工具安装。
3. **Collect 单向且可复查**：Inspect 形成可被后续 Probe 复用的 Facts，Probe 产生时间点或时间窗口内的
   Observations，再进入 Detector 和 Render；Detector/Render 不访问外部资源。Inspect 的获取状态
   归 query-level result，领域信息按形态使用单值 `ValueFact`、带稳定 key 的可重复 `RecordFact` 或
   Identity 关系 `RelationFact`；Core 不解释业务私有 value/record 内部结构，并独占遍历、预算与 Evidence 编排。SDK 定义的标准
   Record（如 `collect.window`）由对应领域消费者按公开契约校验、消费，Data 引擎仍不解释其业务时间含义。
4. **分层不穿透**：业务目标与私有语义归外部 Plugin，标准基础设施采集与分析归 CLI Core，公共契约归
   `packages/plugin`；命令必须先完成配置、contribution/capability、环境和实际 access 准备，再进入领域工作，具体 Plugin
   不能反向依赖 CLI。
5. **Catalog 与运行状态分开**：Catalog 只声明可能提供的 contribution/capability；collect 再结合现场环境判断本次
   是否可用。
6. **Case 资产与消费流程分开**：Service.cases 贡献离线目录、运行时 producer 和单请求 runner；Health 通过 health.case.bindings 引用来源和消费方 Workload。Plugin case runner 每次只触发一个 Case；Eval 顺序执行每个选中 Case
   一次并保留关联证据，Perf/Core 独占并发调度、预算、熔断和 Window 归约。两者都不在 runner 内隐藏循环。
7. **工具与执行通道分开**：根目录 `toolkit/` 只分发版本化资源；CLI `infra/toolkit` 按 Host process、
   Host container 或 Kubernetes container 的实际 OS/arch 选取资源，再交给对应 infra adapter 执行。
   同一 Host 能力同时支持 container 与 process 时，先探测已有且可用的本地 container；不可用才回退
   本机进程。探测本身不隐式 load image 或改变 Host 状态。
8. **可观测性按读者分层**：终端错误通过 stderr 提供面向现场用户的原因、版本、命令、失败阶段；失败证据通过结果中的 diagnostics 进入归档，不另建命令专用错误日志；`--debug` 仅在显式启用时
   向 stderr 展开完整异常链与 stack。诊断记录不得直接写入完整 argv、环境变量或未经脱敏的凭据与协议正文。
9. **默认交付兼顾阅读与完整取证**：诊断命令通常默认同时交付外置 HTML 和完整
   `tar.gz`；S3 对象浏览默认终端 Summary。Bundle 解压后只产生一个顶层目录，首选根 `report.html` 阅读完整报告，通过根 manifest 定位各 Artifact 的领域 JSON、原始 Evidence 与附件；
   finalize 在该目录生成 `AGENTS.md`，说明面向人的 HTML 完整路径、证据阅读顺序和不可信 raw 内容边界。
   显式 format 选择交付视图，不改变采集范围。领域 Command 通过 `CommandSpec.run` 返回本次调用的状态和 Artifacts；组合命令显式纳入子结果，
   根与 Artifact manifest 只保存元数据和证据索引，不重复内嵌 raw 正文；Render 按索引读取，约束见
   `docs/command-output.md` 的“证据与清单”。
   根入口统一 finalize：释放 Client 后调用 CommandSpec.serialize，再按需 render 和 Delivery；序列化只处理本地结果与显式子引用。单次调用的临时资源与产物独立，环境、决策、共享基础设施资源及取消信号在整轮内共享。

## References

- [Command 生命周期](docs/command-lifecycle.md) — 准备扩展点、Service 选择、幂等调用和资源归属
- [配置与目标](docs/configuration.md) — 参数来源、Environment 身份和 Chat/Skill 目标传递
- [数据源生命周期](docs/datasource.md) — ClientManager、DataSource、Transport 与协议访问装配
- `docs/collect-protocol.md` — Collect 数据流、Probe 调度、部分完成、Evidence 与退出码契约
- `docs/rendering.md` — 基于 Command Output 的 HTML 页面组织、交互导航与离线加载
- `docs/plugin.md` — Plugin capability、上下文、分发与信任边界
- `docs/extension.md` — 面向各类 Command 的 Extension 协议、调用边界与接入示例
- `docs/distribution.md` — Doctor 发行版的身份、命令展示与 Plugin 装配边界
- `docs/command-output.md` — Command 输出数据的规范与组织：执行结果、Evidence 保存、manifest 清单与交付
- `docs/commands/eval.md` — Eval 数据集触发、关联证据采集与质量评估边界
- `docs/commands/case.md` — Case 目录、发送与 HTTP 取证边界
- `docs/commands/resource.md` — Service Resource 声明、只读快照、kind 筛选与覆盖边界
- `docs/commands/knowledge.md` — 结构化知识、作用域、引用与词典查询
- `docs/commands/compute.md` — 集群容量、Service Workload 资源与权限覆盖
- `docs/commands/health.md` — 系统体检、消费方 Case 与主动请求审批
- `docs/commands/overview.md` — Facet / Entry 契约、概览与可选采集
- `docs/commands/perf.md` — Perf 主动施压、共享契约与可观测证据编排
- `docs/commands/tenant.md` — Tenant 身份选择、业务类型分页与共享数据查询
- `docs/commands/s3.md` — Service S3 连接、mc 风格路径与有界对象取证
- `docs/commands/db.md` — Service DB 目标、交互参数与有界只读 SQL 取证
- `docs/naming.md` — chat 内部短名与跨边界公开命名约定
- `docs/commands/` — 各 `doctor <command>` 的领域理念、主流程与关键设计

- `docs/commands/resize.md` — 手动调整内存上限、授权、操作记录与生效边界
