# Tenant 数据采集

## 理念 / 概念

`doctor tenant` 与 `doctor data` 都是数据采集 Command。前者以 tenant-id 为根 Identity，采集租户粒度
Fact（包括表达 Identity 关系的 Relation）；后者以 biz-id 为根 Identity，采集消息、会话等业务对象粒度的 Fact。
`doctor tenant` 通过租户目录确定 Identity，再组合 Plugin 已经提供的可复用 Capability，把返回的
Model 或 `ServiceInspectResult` 组织为 Tenant Evidence；同一次 Inspect Query 可以返回多个领域 Fact。

- **Tenant identity**：由 Plugin 声明的 `tenantDirectory` capability 解析。
- **Model Fact**：直接复用 Plugin `model.catalogService` 指向的 Model Catalog。
- **Service Inspect Fact**：来自 `accepts` 包含 `tenant_id` 的 Service Inspect Capability。
- **Evidence**：由 Tenant Command 负责失败隔离、Coverage、Bundle 与报告展示。

## 流程

1. Core 解析 profile、namespace 与 Kubernetes 连接，通过租户目录确定 tenant-id。
2. Command 形成 `{ identity: { kind: "tenant_id", value } }` Query。
3. Command 查询 Model Catalog，并选择接受 `tenant_id` 的 Inspect Capability；每次调用独立准备 access 和
   `PluginContext`，完成后回收连接与 port-forward。
4. 每个 `ServiceInspectResult` 形成一条带 query 获取状态的 Tenant Fact；单个 Capability 失败不丢弃其它已取得事实。
5. Command 汇总 Facts，计算 Coverage，并生成 Evidence、Markdown 与 HTML。

Tenant Command 当前只消费返回的 Fact，尚不沿 Relation 继续查询。协议仍保留 Capability 返回的 Relation；
出现真实场景后，由 Tenant Command 决定是否继续形成 Query，以及深度、数量、去重和失败预算，Capability
不自行递归。

## 关键设计

### Query 作用域与 Capability 归属分开

Tenant 与 Data 分别以 tenant-id、biz-id 形成数据采集入口，但不因此复制数据能力。Model Catalog 可同时被
Tenant、Model 与 Chat 消费；Inspect Capability 只声明接受的 Identity 与提供的 Fact / Relation，不感知
调用它的 Command。

### Command 拥有诊断视角

Plugin 不再返回 tenant report contribution，也不拥有 Tenant 报告 schema。Plugin 负责私有存储查询和
领域 Fact；Command 负责选择哪些 Fact 进入本次 Evidence，以及如何表达 Coverage 和报告。展示逻辑不能
反向驱动 Capability 选择或 Relation 遍历。

### 主动诊断保持独立

Tenant 只读取当前现状。需要产生业务流量、执行验证或性能采样的领域命令继续通过 Probe/Operation
产生 Observation，不把主动行为包装成 Fact。
