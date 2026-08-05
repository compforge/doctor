# Service 配置统计

## 理念 / 概念

`doctor config` 展示两个彼此独立、版本无关的配置事实来源：

- **Env**：Kubernetes Deployment 为业务 Container 声明的环境配置，包括 `envFrom.configMapRef`、`env[].valueFrom.configMapKeyRef` 与显式 `env`。通常 ConfigMap 承载普通配置，显式 Deployment env 承载密码、密钥等配置。不读取整个 Pod 的运行时 env，也不导入业务代码或 Pydantic Settings。
- **Tenant config**：Plugin 声明的租户配置来源。每条值同时保留其 `scope`，不混入代码默认值或缓存结果。

报告按不区分大小写的配置名归并，同名配置只占一行，Env 与 Tenant config 分别占一列。两列用于对照来源，不计算或声称某个“最终生效值”。

## 流程

1. app 注入当前 `PluginDefinition`；配置确认从 Catalog 中具备 config capability 的 Service 与当前 Namespace 实际 Service 求交集，并按需选择租户。
2. `config-targets` Inspect 一次读取 Namespace 中的 Service、Deployment 和 ConfigMap。Service selector 定位对应 Deployment，再以 Service port 或同名规则定位业务 Container。
3. Env Probe 解析目标 Container 的 ConfigMap 与 Deployment env。显式 env 按 Kubernetes 语义覆盖同名 ConfigMap；Secret 引用不读取 Secret 对象。
4. 指定租户时，Doctor 把配置 Service 的 Env 放进 `PluginContext`；Plugin 自己解析数据源、建立有界连接
   并读取声明的 scope。
5. Evidence 以配置名归并两类 Observation；HTML 和 Markdown 都输出 `name | Env | Tenant config` 一张表，
   Tenant config 单元格内标明 scope。HTML 表支持按 name 检索。
6. 必需证据不完整时统一交付 Evidence Bundle；Kubernetes 原始响应不落盘，报告只保存归并后的配置结果。

## 关键设计

### 为什么不读取 Pod env 或 Settings

这个命令的目标是盘点部署声明与策略中心落表配置，而不是推断特定版本业务代码解析后的最终值。Pod env 会混入 Kubernetes 自动注入项和其它运行时来源；导入 Settings 又依赖各版本模块路径、默认值和框架实现。直接读取 Deployment 与 ConfigMap 能保持业务版本无关，也准确限定 Env 列的来源。

### ConfigMap 与显式 env 的关系

大多数部署不会在 ConfigMap 和显式 env 中声明同名配置。若意外重复，Doctor 仍遵循 Kubernetes 的确定性优先级：显式 `env` 覆盖 `envFrom` 引入的 ConfigMap 值，并在 Env 列中只保留一个结果。

### 为什么由 Plugin 读取租户配置来源

不同 Plugin 的配置 API 可能组合默认值、数据库覆盖和缓存，无法统一回答“实际保存了哪些记录”。Plugin 持有
数据源身份、连接实现与查询语义，collect 只注入 `PluginContext` 并消费通用 reader；Doctor 仅托管
port-forward 与命令结束时的资源回收。

### 为什么不合并成最终值

Env 和 Tenant config 是两个来源，二者是否在业务运行时形成覆盖关系取决于具体服务与版本。报告只按
名字横向对照并保留 scope，避免把观察到的来源误表述成统一的生效优先级。
