# Service 配置统计

## 理念 / 概念

`doctor config` 在用户选择 Service 后，同时展示工作负载现状和两个彼此独立、版本无关的配置事实来源：

- **Workload runtime**：Service selector 当前匹配的 Pod 数量、Pod phase，以及每个普通 Container 的完整镜像引用和 CPU/Memory requests/limits。这里展示 Kubernetes 声明与当前对象清单，不把资源声明误写成实际使用量。
- **Env（可选）**：用户确认后，读取 Kubernetes Deployment 为业务 Container 声明的环境配置，包括 `envFrom.configMapRef`、`env[].valueFrom.configMapKeyRef` 与显式 `env`。通常 ConfigMap 承载普通配置，显式 Deployment env 承载密码、密钥等配置。不读取整个 Pod 的运行时 env，也不导入业务代码或 Pydantic Settings。
- **Tenant config**：Plugin 声明的租户配置来源。每条值同时保留其 `scope`，不混入代码默认值或缓存结果。

报告按不区分大小写的配置名归并，同名配置只占一行，Env 与 Tenant config 分别占一列。两列用于对照来源，不计算或声称某个“最终生效值”。

## 流程

1. app 注入当前 `PluginDefinition`；配置确认从 Catalog 中具备 config capability 的 Service 与当前 Namespace 实际 Service 求交集。Service 选择完成后，交互询问是否采集 Deployment Env/ConfigMap；非交互命令只有显式传入 `--deployment-config` 才采集。
2. `config-targets` Inspect 始终读取 Namespace 中的 Service 和 Pod。只有用户确认后才读取 Deployment 和 ConfigMap；Service selector 既定位当前 Pod，也按需定位对应 Deployment。
3. Inspect 将每个所选 Service 的 Pod 数量、phase、Container 镜像与资源声明记为独立 Fact；Pod 列表权限或解析失败时保留其它配置证据，并在 Coverage 中标明缺口。
4. 用户确认时，Env Probe 解析目标 Container 的 ConfigMap 与 Deployment env。显式 env 按 Kubernetes 语义覆盖同名 ConfigMap；Secret 引用不读取 Secret 对象。用户跳过时不发起这两类 Kubernetes 查询，并明确记录 skipped 步骤和不足的 Env Coverage。
5. 指定租户时，Doctor 把当前 Kubernetes 环境和配置 Service 身份放进 `PluginContext`；Plugin 自行
   定位运行实例、解析数据源、建立有界连接并读取声明的 scope。
6. HTML 和 Markdown 先输出 Pod 运行态表，再以配置名归并两类 Observation，输出 `name | Env | Tenant config` 配置对照表；Tenant config 单元格内标明 scope。HTML 配置表支持按 name 检索。
7. 用户选择只采集 Pod 运行态时，报告按 partial 正常交付；完全没有形成可用证据或交付失败时才回退失败 Evidence Bundle。Kubernetes 原始响应不落盘，报告只保存归并后的事实。

## 关键设计

### 为什么不读取 Pod env 或 Settings

这个命令的目标是盘点部署声明与策略中心落表配置，而不是推断特定版本业务代码解析后的最终值。Pod env 会混入 Kubernetes 自动注入项和其它运行时来源；导入 Settings 又依赖各版本模块路径、默认值和框架实现。直接读取 Deployment 与 ConfigMap 能保持业务版本无关，也准确限定 Env 列的来源。

### 为什么 Env/ConfigMap 需要单独确认

Pod 数量、镜像和资源声明是常规工作负载事实；Deployment env 与 ConfigMap 则可能直接包含密码、密钥等业务数据。Doctor 在 Service 选择后单独确认，只有用户明确需要时才申请相关读取权限并采集。拒绝后已有 Pod 事实仍可交付，但报告必须把 Env 目标标为不充分，从而保留“用户只要求一部分”的真实范围。

### 为什么 Pod 运行态与配置对照分开展示

Pod 数量、镜像和资源声明回答“所选 Service 当前落到了哪些工作负载”，Env/Tenant config 回答“配置数据来自哪里”。二者更新节奏与缺失原因不同，拆成独立 Fact、Coverage 和表格后，Pod 权限不足不会掩盖已经取得的配置证据，也不会把 requests/limits 误解为资源使用指标。

### ConfigMap 与显式 env 的关系

大多数部署不会在 ConfigMap 和显式 env 中声明同名配置。若意外重复，Doctor 仍遵循 Kubernetes 的确定性优先级：显式 `env` 覆盖 `envFrom` 引入的 ConfigMap 值，并在 Env 列中只保留一个结果。

### 为什么由 Plugin 读取租户配置来源

不同 Plugin 的配置 API 可能组合默认值、数据库覆盖和缓存，无法统一回答“实际保存了哪些记录”。Plugin 持有
数据源身份、连接实现与查询语义，collect 只注入 `PluginContext` 并消费通用 reader；Doctor 仅托管
port-forward 与命令结束时的资源回收。

### 为什么不合并成最终值

Env 和 Tenant config 是两个来源，二者是否在业务运行时形成覆盖关系取决于具体服务与版本。报告只按
名字横向对照并保留 scope，避免把观察到的来源误表述成统一的生效优先级。
