# CPU 诊断

## 理念与概念

`doctor cpu` 面向 Kubernetes 中 Python 长驻服务的 CPU 高占用、请求卡顿和线程阻塞问题。它先采集目标容器当前的 CPU/内存占用、Python 进程和 ptrace 能力等 Facts，再决定能否执行 py-spy。Facts 只描述当前环境与能力，不把“CPU 高”直接当成根因；py-spy 线程栈才是后续判断代码位置的诊断证据。

py-spy 与 tracemalloc 分属两个领域：py-spy 观察 Python 线程当前停在哪里，适合 CPU 热点、卡顿和阻塞定位；tracemalloc 追踪 Python 分配，属于 `doctor mem`。`doctor cpu` 的任何路径都不会启用或注入 tracemalloc。

当前产物是 Evidence Bundle。单次 `py-spy dump` 是某一时刻的线程栈快照，能帮助定位卡住的位置或大量线程共同停留的位置，但不等同于持续采样得到的 CPU profile 或火焰图，也不能仅凭一份快照证明某个函数持续消耗 CPU。

## 流程

Prepare 先解析 Pod 与容器；随后 Core 通过 `runCollect` 驱动全部 Inspect，Python PID 也在 Inspect 阶段
从冻结前的进程扫描事实中确定。当前采集以下公共 Facts：

1. `kubectl top pod --containers` 返回的容器 CPU、内存用量及其相对 limit 的比例；
2. `/proc` 中的 Python 进程列表与目标 PID；
3. 目标容器是否已有 py-spy；
4. `ptrace_scope`、有效 capability 和 Pod spec 中的 `SYS_PTRACE` 声明；
5. 当前 Pod 是否已有与目标容器共享 PID namespace、声明 `SYS_PTRACE` 且 Running 的 doctor-debug 临时容器。

全部 Inspect 完成并冻结 Facts 后，Core 才规划 py-spy Probe。执行前会输出本轮 Facts 中的 CPU 和内存占用。
如果任一指标达到容器 limit 的高占用阈值，命令会提示当前负载和额外采样风险，并要求用户确认后才继续。
缺少 limit 或 metrics-server 数据时会明确说明没有取得占用比例，不伪造判断。Probe Observation 随后进入
Evidence、空 Detector 集与线程栈 Coverage，Render 只消费形成的 Diagnosis。

三种 mode 控制允许的最大副作用。py-spy 是按需执行的采样器，不是需要常驻启动的服务。CPU probe 不再安装、上传工具或修改 Pod；需要额外工具和 `SYS_PTRACE` 时，由用户先通过 `doctor debug` 显式准备通用临时容器。

| 目标状态 | `observe` | `overhead` | `disrupt` |
|---|---|---|---|
| 业务容器已有 py-spy 且可 attach | 只采集 Facts | 直接执行 `py-spy dump --nonblocking` | 使用已就绪 doctor-debug 容器中的 py-spy |
| 业务容器缺 py-spy 或不可 attach | 只采集 Facts | 线程栈证据记为 unavailable，并提示准备 doctor-debug | 使用已就绪 doctor-debug 容器中的 py-spy；未准备时明确提示先运行 `doctor debug` |

`doctor-debug` 镜像按目标架构携带 `/opt/doctor/bin/py-spy`。`doctor cpu --mode disrupt` 复用 Inspect 已选定的唯一容器，执行前再次验证 py-spy、有效 `CAP_SYS_PTRACE` 与 `ptrace_scope`，然后 attach 原业务 PID。CPU 命令本身不会发布镜像、创建临时容器或 rollout 业务 Deployment；runtime 的选择和准备统一由此前的 `doctor debug` 完成。

## 关键设计

### Facts 与基础设施是公共能力

CPU 与 memory 共用的容器资源占用、进程扫描和 doctor-debug Facts 位于 `src/collect/fact/`。kubectl 执行、Pod/容器解析与临时调试容器能力位于 `src/infra/`。领域目录只保留 CPU 或 memory 自己的 Facts、probe、Observation 和 renderer，避免两个命令复制并逐渐分叉同一套 K8s 行为。

### 高负载提示发生在具体 probe 前

资源占用在 Inspect/Facts 阶段只采一次，通过 `Probe.run(ctx, facts)` 传给 py-spy probe。是否提示和确认由 py-spy probe 决定，因为风险来自“在当前负载下继续执行这个 probe”，而不是来自 Fact 本身。其它 probe 将来可按自身开销复用同一 Fact，采用不同门槛或无需确认。

### debug environment 由显式命令准备

通用工具镜像由 `doctor image` 发布，临时容器由 `doctor debug` 管理；CPU probe 只消费已准备好的 runtime。这使镜像发布、Kubernetes mutation 与 CPU 证据采集拥有独立授权和生命周期，也避免为了取得一份线程栈重启业务 Pod、重置正在排查的 CPU 现场。

### 结论不超出证据能力

报告聚合相同栈顶的线程，帮助发现锁竞争、线程堆积或共同阻塞位置；但单点快照可能恰好采到等待态。需要判断持续 CPU 热点时，应结合多次采样或后续连续 profile 能力，并同时参考容器 CPU 曲线、请求时延和发生时间窗口。
