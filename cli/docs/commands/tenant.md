# Tenant 汇总

## 理念 / 概念

`doctor tenant` 以租户为检查对象，汇总租户身份、Plugin 声明的租户配置和该租户当前可用的模型目录。
它与按 biz-id 展开业务对象关系的 `doctor data` 并列，也与针对单个模型执行主动请求的 `doctor model`
分工：Tenant 只形成可离线复查的 Inspect Facts，不执行 validation、inference 或性能采样。

- **Tenant identity**：由 `tenantDirectory` capability 解析的租户 ID、名称和显示名。
- **Tenant configuration**：由 `tenantConfiguration` capability 按 scope 读取的配置事实；数据源身份、
  连接和私有 schema 留在 Plugin。
- **Model catalog**：由 `modelCatalog` capability 返回的租户可用模型，包括身份、类型、provider、可用性、
  上下文、维度、输入模态、capacities、features、计费摘要和时间信息。capacities/features 是不透明的稳定
  名称，Core 负责保存和展示，不猜测厂商语义；凭据、额外请求头和厂商私有原始配置不进入公共 Model 数据。

## 流程

1. 解析 profile、namespace 与 Kubernetes 连接信息，通过租户目录解析 `--tenant-id` / `--tenant-name`；
   交互终端缺省时选择当前启用租户，非交互环境必须显式指定。
2. Tenant Inspect 读取该租户的完整模型目录，并按公共 Model 白名单把安全的模型清单信息形成 Facts。
3. Plugin 提供 `tenantConfiguration` 时，Inspect 为每个声明 scope 读取配置并独立记录成功或缺失；
   未提供该 capability 时仍交付租户身份和模型目录。
4. Renderer 把 HTML、JSON 与完整 Evidence 写入 Artifact 目录并注册到共享 `CommandContext`；顶层
   finalize 按 format 统一交付独立 HTML、完整 Bundle 或显式 JSON。
5. `doctor collect` 选择 tenant 数据面时，调用同一个 `runCollectTenant` 入口，并通过共享
   `CommandContext` 复用租户选择；集合层不读取模型目录或租户配置。

## 关键设计

### 租户是独立聚合粒度

biz-id 只能表达一次消息、会话或其它业务对象，不能稳定推导租户；模型目录和租户配置则天然以 tenant-id
为查询边界。把两者塞进 `doctor data` 会迫使 Core 猜测 Plugin 私有 identifier，因此 Tenant 使用独立
Config、Facts 和 Evidence 生命周期。它是 Application 数据作用域之一：与现有 biz-id 粒度并列，也允许
未来按同样原则增加 user-id 等粒度，而无需改变 Collect 的组合职责。

### 汇总与主动探测分开

Tenant 报告回答“该租户当前声明了哪些配置和模型能力”；Model 诊断回答“选定模型能否 validation、
inference，以及轻量性能表现如何”。两者消费同一 Model Catalog 契约，但只有 `doctor model` 创建
inference handle 并产生主动流量。二者各自拥有 Config、CommandContext、Inspect/Evidence 与 Renderer，
不会调用或导入对方的 command 实现；共享边界止于通用 Model Capability、Model 数据和访问准备。

### Service 配置与租户配置分开

Deployment Env/ConfigMap 属于 Service/workload 的部署声明，仍由 `doctor inspect` 负责；按 scope 保存的
租户配置属于租户事实，由 `doctor tenant` 负责。名称相同不表示二者存在通用覆盖顺序，报告不拼装所谓
“最终生效配置”。
