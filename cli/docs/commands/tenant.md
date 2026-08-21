# Tenant 汇总

## 理念 / 概念

`doctor tenant` 以 tenant-id 为稳定查询边界，汇总租户身份与当前 Plugin 提供的租户粒度业务
事实。Core 只理解 Tenant identity、Contribution、Fact/Coverage 和报告 IR；具体领域、私有查询、
公开字段白名单与展示 schema 均由 Plugin 拥有。

- **Tenant identity**：由 Plugin 声明的 `tenantDirectory` capability 解析。
- **Tenant contribution**：Service 提供的租户粒度只读快照，每个贡献独立声明 access、标题与
  采集函数。
- **Tenant report IR**：只允许标量 summary 和列式 table；不允许 Plugin 返回任意 HTML 或未约束的
  嵌套 JSON。

## 流程

1. Core 解析 profile、namespace 与 Kubernetes 连接，通过租户目录确定 tenant-id。
2. Core 按 Service Catalog 顺序执行每个 contribution；每个贡献独立准备 access 和 `PluginContext`，
   并在完成后回收连接与 port-forward。
3. 返回值先经过运行时 IR 校验，再形成独立 Fact；单个贡献失败不丢弃其它已取得事实。
4. Core 根据 Fact 状态与 `missingEvidence` 统一计算 Coverage，并安全生成 Evidence、Markdown 与
   HTML。`doctor collect` 复用同一入口，不理解贡献内容。

## 关键设计

### 租户是独立 Application 作用域

biz-id 表达消息、会话或其它业务对象，不能稳定推导租户。Tenant 因此拥有独立的身份解析、
Facts 与 Evidence 生命周期，与 `doctor data` 的 biz-id 作用域并列。

### 贡献边界隔离业务演进

新增一类租户事实时，Plugin 只新增 contribution 及其私有领域实现；Core 的 Inspect、Coverage、
Evidence 与 Renderer 不新增领域分支。Contribution 不是任意数据通道：它只能返回受限报告 IR，
而资源访问仍受每个 capability 的 access 契约约束。

### 贡献与主动诊断分开

Tenant contribution 只读取当前现状。需要产生业务流量、执行验证或性能采样的领域命令继续拥有自己的
capability、Config 和 Evidence 流程，不与 Tenant 汇总器复用业务实现。
