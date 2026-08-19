# Service Inspect

## 理念 / 概念

`doctor inspect` 以 Service 为检查对象，形成两类彼此独立的现场事实：Service 的运行载体（workload）与 Service 的配置。`config` capability 仍只声明 Service 是否支持配置检查，不限制基础 workload 检查。

- **Workload runtime**：Service selector 当前匹配的 Pod、Container、镜像、CPU/Memory requests/limits、就绪状态、重启次数和上一次终止原因。`OOMKilled`、exit code 与 `CrashLoopBackOff` 等状态作为现场事实展示，不把资源声明误写成实际使用量，也不把退避状态误写成根因。
- **Toolchain**：Plugin 对 Service 的源码语言、执行平台、依赖管理器与构建工具声明。它用于选择通用采集器，不冒充当前 Pod 的现场事实。
- **Env（可选）**：用户确认后，读取 Kubernetes Deployment 为业务 Container 声明的环境配置，包括 `envFrom.configMapRef`、`env[].valueFrom.configMapKeyRef` 与显式 `env`。通常 ConfigMap 承载普通配置，显式 Deployment env 承载密码、密钥等配置。不读取整个 Pod 的运行时 env，也不导入业务代码或 Pydantic Settings。
- **Runtime dependencies（可选）**：用户确认后，由 Core 进入代表 Container，按 Toolchain 选择语言采集器并取得实际依赖与版本。依赖清单可能包含内部包名，因此与 Env 分开授权。
报告按不区分大小写的配置名归并，同名 Env 配置只占一行。租户配置属于租户粒度，由
[`doctor tenant`](tenant.md) 汇总，不与 Service/workload 配置混在同一报告中。

## 流程

1. app 注入当前 `PluginDefinition`；Service 选择从 Plugin Catalog 与当前 Namespace 实际 Service 求交集。Service 选择完成后，交互分别询问是否采集 Deployment Env/ConfigMap 和应用依赖；非交互命令只有显式传入对应 flag 才采集。
2. `service-targets` Inspect 始终读取 Namespace 中的 Service 和 Pod。只有用户确认后才读取 Deployment 和 ConfigMap；只有声明 `config` capability 的 Service 进入配置检查，Service selector 同时定位其当前 Pod 和对应 Deployment。
3. Inspect 将每个所选 Service 的 Pod、Container 状态、重启/终止原因、镜像与资源声明记为独立 Fact；Pod 列表权限或解析失败时保留其它配置证据，并在 Coverage 中标明缺口。
4. 用户确认时，Env Probe 解析目标 Container 的 ConfigMap 与 Deployment env。显式 env 按 Kubernetes 语义覆盖同名 ConfigMap；Secret 引用不读取 Secret 对象。用户跳过时不发起这两类 Kubernetes 查询，并明确记录 skipped 步骤和不足的 Env Coverage。
5. 用户确认依赖采集时，Inspect 用 Service selector 与 port 定位业务 Container，按实际 `imageID` 去重后每个镜像选择一个 Running Pod。Core 根据 Toolchain 执行有界只读采集，只保存归一化后的包名、版本和现场 runtime version；拒绝后不申请 `pods/exec` 权限。
6. HTML 和 Markdown 分别展示 Pod、Toolchain、应用依赖与 Service 配置；Toolchain 明确标为声明，依赖与 runtime version 明确标为本次现场观测。
7. 用户选择只采集 Pod 运行态时，报告按 partial 正常交付；完全没有形成可用证据或交付失败时才回退失败 Evidence Bundle。Kubernetes 原始响应不落盘，报告只保存归并后的事实。

## 关键设计

### 为什么不读取 Pod env 或 Settings

配置子域的目标是盘点部署声明与策略中心落表配置，而不是推断特定版本业务代码解析后的最终值。Pod env 会混入 Kubernetes 自动注入项和其它运行时来源；导入 Settings 又依赖各版本模块路径、默认值和框架实现。直接读取 Deployment 与 ConfigMap 能保持业务版本无关，也准确限定 Env 列的来源。

### 为什么 Env/ConfigMap 需要单独确认

Pod 数量、镜像和资源声明是常规工作负载事实；Deployment env 与 ConfigMap 则可能直接包含密码、密钥等业务数据。Doctor 在 Service 选择后单独确认，只有用户明确需要时才申请相关读取权限并采集。拒绝后已有 Pod 事实仍可交付，但报告必须把 Env 目标标为不充分，从而保留“用户只要求一部分”的真实范围。

### 为什么 Toolchain 由 Plugin 声明、依赖由 Core 采集

Service 拥有自己的源码语言和构建方式，Plugin 最适合声明这些稳定知识；进入 Container、控制权限与预算、解析通用语言依赖并形成 Evidence 则是 Core 的标准基础设施职责。Toolchain 只帮助 Core 选择采集器，实际镜像、runtime version 和依赖仍从 Target 观察，避免 Plugin 版本滞后时把期望状态误报成现场状态。

### 为什么依赖单独确认并按镜像采集

依赖清单可能暴露内部包名，而且需要 `pods/exec`，不能跟随普通 Pod 列表隐式发生。依赖属于构建产物而非 Pod 副本；同一 `imageID` 的多个 Pod 只需选择一个代表实例，既保持证据身份准确，也限制远端执行次数。

### 为什么 Pod 运行态与 Service 配置分开展示

Pod 数量、镜像和资源声明回答“所选 Service 当前落到了哪些工作负载”，Deployment Env/ConfigMap
回答“这些 workload 声明了什么 Service 配置”。二者更新节奏与缺失原因不同，拆成独立 Fact、Coverage
和表格后，Pod 权限不足不会掩盖已经取得的配置证据，也不会把 requests/limits 误解为资源使用指标。

### ConfigMap 与显式 env 的关系

大多数部署不会在 ConfigMap 和显式 env 中声明同名配置。若意外重复，Doctor 仍遵循 Kubernetes 的确定性优先级：显式 `env` 覆盖 `envFrom` 引入的 ConfigMap 值，并在 Env 列中只保留一个结果。
