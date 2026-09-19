# Doctor SPI：Command 与 Service 的扩展边界

> 状态：设计提案与取舍记录。`CommandSpec.prepare` 已落地；本文的 SPI 命名、接口示例与字段布局
> 尚未整体实现，不替代当前 SDK 契约。现行生命周期见 [Kernel](kernel.md)，Plugin 接入见
> [Plugin](plugin.md)。

## 理念 / 概念

Command 拥有自己的执行流程。在流程中，它需要外部提供部署与资源描述、业务数据和可调用能力。
Plugin 通过 Service 组织这些供给；Core 负责调用边界。设计目标是让新增业务实现能够接入稳定契约，
同时保留 `command.run` 中的分支、循环、并发、子命令组合和领域判断。

统一的是 Command 层的 Prepare → Execute → Finalize。Execute 的内部结构由命令系列拥有：
Collect 使用 Inspect → Probe → Detector，Provision、Eval、Perf、Chat 保留各自的领域流程。
Service 不参与定义另一套 Command 生命周期。

- `command.prepare`：检查 Command 自身需要的权限，以及本次所需 Extension 的权限。
- `command.run`：执行自身逻辑，按需调用 Extension 获取数据或执行操作；取数据也是执行工作。
- Finalize：将 CommandResult 序列化、渲染为输出。

kind 约定提供什么函数、函数的 input / output 及权限要求；Extension 通过 run 和 access 表达实现及
具体访问需求。提供静态数据也可理解为无业务入参的函数。Service 提供 Extension，Command 消费
Extension：一个 Service 可以提供多个 kind，一个 Command 也可以使用多个 kind，两者不一一绑定。

### SPI 的含义

Doctor SPI 采用开放的 Extension 接入协议：Service 自由实现，将对外数据或逻辑包装为 Extension；
Command 自由实现，在需要外部供给的位置按 kind 发现并调用。Core 统一注册、发现、权限、上下文与调用
生命周期，不解释各 kind 的业务输入输出，也不接管 Command 流程。

Extension 统一接入形状和 run 调用形式；kind 标识提供方与消费方共同遵守的领域契约。契约由对应领域
定义，不要求中央 ExtensionContracts 映射或封闭枚举，不以具体命令 DTO 为接口。

Java SPI 中的 service 指接口契约；Doctor 的 Service 指业务服务及其资源归属。两者不能直接等同，
因此不引入含义模糊的 `ServiceProvider` 总接口。

| 概念 | 职责 | 示例 |
|---|---|---|
| Command | 表达本次意图，组织流程并形成结果 | Data、Tenant、Perf |
| Service | 业务身份及资源、实现的归属 | 消息服务、模型服务 |
| Extension | 数据或逻辑的统一接入声明与实现 | workload.describe、facts.inspect |
| kind | 提供方与消费方约定的领域契约标识 | facts.inspect |
| Capability | 扩展提供的行为能力及其约束 | Inspect、CaseRunner、ModelCatalog |
| Provider | 某个具体契约的实现或提供者角色 | 消息 Inspect 实现 |
| Resource | 被定位、访问或操作的对象 | Workload、DataSource |
| Definition | 接入声明，可包含描述、依赖、权限和实现或工厂 | DataSourceDefinition |
| Metadata / Descriptor | 纯描述信息，不表示已取得运行态对象 | 名称、说明、支持的类型 |
| Contribution | 提供或注册扩展的行为 | Service 注册 Inspect 实现 |

这些术语不要求各自增加一个基类或运行时对象。实际查询得到的消息、目标状态等继续使用领域 Result、
Fact、Observation；不能把执行结果与离线描述都称为 Metadata。

### kind 按领域契约划分，不与 Command 一一对应

facts.inspect 表示按 Query 获取 Facts 的能力，不表示它专门实现 `doctor inspect` 命令。
不为每个命令机械增加一个 XxxProvider 或 kind：没有外部供给需求的命令无需 Extension；一个命令可以
调用多种 kind，同一 kind 也可以被多个命令消费。

| kind 示例 | 消费入口示例 | 提供内容 |
|---|---|---|
| workload.describe | 需要定位 Workload 的诊断命令 | 返回 Workload 描述，可以直接返回静态声明 |
| facts.inspect | Data、Tenant | 查询业务 Identity，取得 Facts 与逐项获取状态 |
| case.execute | Eval、Perf | 执行一次 Case；调用方决定次数、并发和窗口 |

这些名称是示例，不构成中央清单。新增 kind 需要实现方和调用方理解其契约，不需要在 Core 的注册、发现、
调用机制中增加业务分支。kind 成立的依据是稳定的领域语义与独立供给边界，不要求已经有多个消费者。

### 为什么需要收敛 capability / contribution

当前 [Service 类型](../../packages/plugin/src/service.ts) 同时暴露 capabilities 与 contributions。
Inspect 位于 contributions，却继承 InspectCapability，并被 Data、Tenant 复用；Case 位于 capabilities，
却继承 ProbeCapability。capabilities 还包含 DataSource、日志默认选择和 Perf 预设。

因此，“是否可复用”和“是否参与 Inspect/Probe”都不能作为两组字段的稳定分界。提案统一为 Extension
接入，通过 kind 区分具体契约；描述数据与执行逻辑都可以被提供，contribution 只表达注册行为。

## 流程

### 主流程与扩展调用

```text
Service 私有实现 / Core 内置实现
                │ 将数据或逻辑包装为 Extension
                ▼
宿主注册与发现：kind + 归属 + 实现身份
                ▲
Command.prepare：选择本次所需扩展，检查自身与扩展权限
                │ 检查通过后进入 Execute
                ▼
Command.run：执行自身逻辑，在需要的位置调用宿主 invoke
                ▼
Core：权限、受限上下文、资源生命周期、来源记录
                │ run(context, input)
                ▼
Extension 返回约定输出 → 领域校验与解释
                ▼
Command 继续自己的流程 → CommandResult → Finalize
```

Command 可以读取 Service 元数据、选择范围和查询 Catalog，不需要隐藏 Service 身份。实际执行经过
宿主调用入口，保留 Service、Plugin 版本及 producer 信息。实现方只接收此次调用所需的受限上下文，
不接收完整 CommandContext，也不根据命令名切换业务行为。

### 开放的 Extension 接口

以下是目标形态示例，不代表当前已经存在的 API：

```ts
interface Extension<Input, Output> {
  readonly id: string;
  readonly kind: string;
  readonly description?: string;
  readonly access: CapabilityAccess;

  run(
    context: ExtensionContext,
    input: Input,
  ): Promise<Output>;
}
```

泛型帮助实现方与消费方表达类型，不要求维护 kind → 类型的全局映射。批量输入、数组输出由具体 kind
决定：facts.inspect 可以处理 Query 列表，case.execute 可以处理单个请求。接受哪些 Identity、产出哪些
Fact 等 accepts/provides 信息可作为该 kind 的扩展声明；不强制每种 kind 都赋予这些字段相同含义。

kind 是契约身份，id 是实现身份，在所属 Service 或内置注册范围内稳定且唯一。加载器补齐归属与版本，
声明者不重复填写。注册时可以校验通用形状；动态实现的业务输入输出仍需领域校验，不能认为泛型或按
字符串匹配就证明了契约符合性。新增 kind 的校验由消费方、实现方共享的领域模块维护。

一个 Service 可以提供多个不同 kind 的 Extension。例如，下面的实现只返回描述数据：

```ts
const workloadExtension: Extension<void, readonly WorkloadDefinition[]> = {
  id: "workloads",
  kind: "workload.describe",
  description: "此 Service 的 Workload 描述",
  access: {},
  run: async () => workloadDefinitions,
};
```

同一 Service 还可以注册 facts.inspect 实现，在 run 中查询远端并返回 Facts。私有数据结构与内部实现
保持自由，对外输出遵守对应 kind 契约。现有静态声明可作为包装实现的单一来源，不重复维护数据。
Catalog 发现只读取注册描述，不自动执行 run；调用返回静态数据也不等于必须访问网络或创建资源。

ExtensionContext 表示宿主提供的此次调用配置、受限访问、取消信号与资源管理能力。内置实现可以使用
同一接入协议，不必伪造 Plugin 或 Service；Plugin 边界额外保留加载、版本和校验责任。

### prepare 检查权限，run 执行工作

prepare 的职责是检查 Command 自身及本次所需 Extension 的权限。为此可以按 kind、Service 范围等
读取注册声明、选出候选并汇总 access；不调用 Extension.run 获取业务数据，也不提前执行命令工作。
权限检查复用宿主机制，Command 不自行实现另一套鉴权。

run 保留 Command 的完整执行自由：执行自身逻辑，按需调用 Extension 取数据或干活，再解释结果、
继续分支和组合。Extension input / output 由 kind 决定，不由 prepare 定义，也不要求所有输出都是 Fact。

下面省略领域类型、校验及结果构造；find、checkAccess、invoke 均为职责示意，不是已实现的 API：

```ts
async function prepare(context, input) {
  const extensions = context.extensions.find("facts.inspect", {
    services: input.services,
  });
  await context.checkAccess(commandAccess, extensions.map(item => item.access));
  return { extensions };
}

async function run(context, input, prepared) {
  const query = buildQuery(input);
  const results = [];
  for (const extension of prepared.extensions) {
    results.push(await context.extensions.invoke(extension, query));
  }
  return buildResult(results);
}
```

prepare 确定权限范围，不编排执行计划。Prepared 可以携带已选 Extension，具体结构由 Command 自己
定义。run 根据中间结果决定实际调用、顺序、并发、进一步查询或子命令组合；Collect 仍遵守自己的
Inspect 屏障、遍历预算和取消约束。

运行中才发现的 Extension 仍须在调用前检查权限；prepare 检查过已有候选，不代表允许任意后续调用。
这只是宿主调用边界的检查，不把取数据或业务执行搬回 prepare。

## 关键设计与取舍

### 统一接入形式，保留两端实现自由

讨论过两种方向：每类能力保留完全独立的提供接口，或者用 Provider<Kind, Definition> 包装后集中管理。
前者不能直接表达统一供给入口，后者若叠加集中式 ExtensionContracts 与统一调度，会让新增 kind 和
Command 流程都受中央模型约束。

选择 Extension<Input, Output> 加开放 kind 和统一 run。统一的是调用形式，不是所有输入输出，也不是
重试、并发、遍历等执行策略。Service 可以包装数据或逻辑，Command 在自己的流程中按需调用；不增加
中央契约映射、完整执行图或为每个命令定义一个 Provider。

### kind 是双方协议，不是任意字符串标签

同一个 kind 的实现和消费方必须约定输入输出、匹配条件、调用前提及错误语义。这些约定属于对应领域，
可以共享类型与校验器，但不要求 Core 枚举所有 kind。显式 Service 范围或实现 ID 用于缩小候选，具体
kind 可以进一步按输入特征筛选；仅匹配 kind 不代表目标可用或已有权限。

公共与私有扩展应选择不会产生语义冲突的 kind 名称，不能让不同协议因字符串相同而被混用。契约演进
需明确兼容边界；此提案不提前引入额外的全局 schema registry。

### 数据供给与逻辑供给使用同一种接入形式

描述 Workload、返回配置投影和查询业务 Facts 都可以通过 Extension 提供。run 返回什么由 kind 约定，
不要求所有结果都变成 Fact，也不要求所有调用都触发外部访问。Service 内部的静态数据、工厂和客户端
不因此改变其原有职责；资源应通过现有宿主机制获取和回收。

不要求额外的 BaseDefinition 或全局 accepts/provides 字段。现有 Inspect.resolveTarget 带数据库描述，
不能推广成所有 Extension 都必须具有的操作。

### 扩展点由领域拥有，不按所有命令暴露任意 hook

Inspect 等契约应能被 Data、Tenant 等多个入口消费。不会为每个命令增加 beforeRun、afterRun 等任意
回调，也不让实现根据命令名切换行为。扩展点的输入输出、可调用阶段和结果解释由所属领域定义。

每个 SPI 必须明确多实现语义：是显式选择一个、收集多个，还是按顺序尝试，以及无匹配、失败、取消时
如何处理。Extension 内部可处理输入批次，但不得隐藏命令拥有的跨实现遍历、调度或负载循环。
顺序确有语义时才增加排序规则；不能用全局 priority 代替数据依赖、预算或领域策略。

### prepare 汇总权限，调用时维持权限边界

Extension.access 声明其 run 操作的访问需求；资源依赖已有的权限声明由宿主解析复用，不手工维护
两份同义清单。命令需求来自本次实际选择的 Extension、资源、依赖及自身动作，不是整个 Service 或
Plugin 的权限并集。

prepare 检查命令自身及所需 Extension 的权限；运行中新增需求在调用前补充检查。汇总用于检查和
展示，每个实现拿到的上下文仍只包含其声明与授权范围。能力存在性、访问权限和有副作用动作的批准是不同条件，不能互相替代。

单次调用的临时资源归调用作用域，共享 Client 归根生命周期。复用现有上下文与 Client 管理机制，不为 SPI
再建一套清理流程。部分实现失败时保留其它结果及来源；失败隔离和取消语义由具体 SPI 明确约定。

### SPI 不接管 Command 生命周期

Prepare → Execute → Finalize 继续由 Command 层拥有。Collect 的阶段、Evidence 与 Coverage 由 Collect
领域负责；其它系列不为了接入扩展而进入 Collect 引擎。序列化和渲染只消费本地结果，不借 SPI 继续取证。

新增 kind 不要求修改 Core 的注册和调用机制；新增命令、共享基础设施或领域功能仍可能需要修改 Core。
公开契约变化仍需考虑 Plugin 版本、结果 schema 和加载校验，不能把 TypeScript 编译通过当作协议兼容。

## 参考实现及借鉴边界

| 参考 | 观察到的机制 | Doctor 的选择 |
|---|---|---|
| Netfilter（Linux v6.12） | 网络栈显式触发 hook；注册项描述回调、位置、优先级；调用器解释 verdict | 保留主流程控制权，明确局部扩展契约；不照搬报文 verdict、任意修改上下文或接管后续处理 |
| Java SPI（Java 21） | 接口定义契约，ServiceLoader 发现并按需实例化；应用选择和调用实现 | 采用契约与实现分离；保留现有 Plugin 加载，不复制 classpath 扫描或统一工厂机制 |
| Trino（源码 477） | Plugin 提供扩展入口，Connector 分别提供 Metadata、SplitManager、PageSourceProvider 等 | 借鉴描述与行为的领域契约；Doctor 选择统一 run 接入，但不统一各 kind 的输入输出 |
| Pluggy（源码 1.6.0） | hookspec、hookimpl、调用器分离；契约区分聚合与 firstresult | 主流程决定调用位置，各 SPI 明确多实现语义；不把所有能力都变成事件广播 |
| CSI（规范 1.9.0） | 按 Identity、Controller、Node 定义存储协议，能力声明决定可调用操作；卷操作约定前置条件与幂等语义 | 按领域能力定义 SPI，把能力存在性、调用前提、失败及重试规则写入契约；不按 CLI 命令拆插件 |
| CNI（规范 1.1.0） | 网络协议约定 ADD、DEL、CHECK 等操作与版本；运行时执行插件列表并传递结果 | 借鉴小型领域协议、版本边界和明确组合规则；不把全部 Doctor 能力做成同一条插件链 |

### CSI / CNI 对接口粒度的启发

CSI 的 NodePublishVolume 等是存储领域操作，不是某个 kubectl 命令的远端实现。Kubernetes 中 kubelet
调用 CSI Node 服务，Controller 服务通常由相应 sidecar/controller 调用。CSI 同时约定卷操作的合法
状态转换与幂等要求，因此“主流程自由”不表示调用方可以违反具体能力的前置条件或任意重试。

CNI 是容器网络协议，现代 Kubernetes 通常由容器运行时集成调用，不能把 CSI、CNI 都理解为 kubelet
直接调用的同一种插件机制。规范区分插件配置、调用参数和结果，规定 ADD 的顺序执行及结果传递、DEL
的逆序清理；也允许明确的插件委托。这里的 ADD/DEL 是协议操作，不对应面向用户的 CLI 命令。

两者说明应稳定“领域操作与数据契约”，而不是把宿主整个流程交给外部。Doctor 的同进程类型化 SPI
可以采用相同分工，不必引入 gRPC、独立进程、动态注册服务或 CSI/CNI 的部署结构。能力声明与实际现场
可用性仍分开；不可用、未支持、调用失败和取消不能折叠成同一个空结果。

来源：

- Netfilter：[调用位置](https://github.com/torvalds/linux/blob/v6.12/net/ipv4/ip_input.c#L532-L544)、
  [注册契约](https://github.com/torvalds/linux/blob/v6.12/include/linux/netfilter.h#L81-L99)、
  [verdict 处理](https://github.com/torvalds/linux/blob/v6.12/net/netfilter/core.c#L585-L615)。
- Java：[ServiceLoader 契约与设计建议](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/ServiceLoader.html)。
- Trino：[Plugin](https://github.com/trinodb/trino/blob/477/core/trino-spi/src/main/java/io/trino/spi/Plugin.java)、
  [Connector](https://github.com/trinodb/trino/blob/477/core/trino-spi/src/main/java/io/trino/spi/connector/Connector.java)。
- Pluggy：[契约与实现](https://github.com/pytest-dev/pluggy/blob/1.6.0/src/pluggy/_hooks.py)、
  [调用与结果处理](https://github.com/pytest-dev/pluggy/blob/1.6.0/src/pluggy/_callers.py)。
- CSI：[协议与卷生命周期](https://github.com/container-storage-interface/spec/blob/v1.9.0/spec.md)、
  [Kubernetes 调用方与部署分工](https://kubernetes-csi.github.io/docs/deploying.html)。
- CNI：[领域操作、组合、版本和结果契约](https://github.com/containernetworking/cni/blob/spec-v1.1.0/SPEC.md)、
  [Kubernetes 网络插件](https://kubernetes.io/docs/concepts/extend-kubernetes/compute-storage-net/network-plugins/)。

## 提案落地范围与待验证项

先在现有 `packages/plugin` 中明确 Extension 接入形状，以 facts.inspect 为例包装现有实现，并让 Data、
Tenant 验证按 kind 发现和统一调用。复用当前上下文、权限检查及结果校验，不新建加载器或执行引擎。
再以 workload.describe 验证返回静态描述数据的场景，避免实现只适合远端查询。

现有字段作为单一声明来源时可以生成 Extension 视图，不能长期维护两份注册或数据清单。公开注册字段
与异构 Extension 集合的 TypeScript 表达由实现验证，不用全局 ExtensionContracts 解决类型擦除问题。
kind 不能自动推导运行时类型，输入输出校验须在领域边界落实。

验收重点是同一 kind 被多个命令复用、Service 同时提供数据与逻辑、增加 kind 不改中央调用分支、选择
范围与权限不扩大、动态调用可取消、资源正确回收、失败证据和 producer 来源保留。Inspect 目标描述的
数据库假设、最小受限上下文、kind 的实例粒度与多实现选择语义仍需通过真实调用链验证。
