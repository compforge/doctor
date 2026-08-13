# Debug container 设计

## 理念 / 概念

Debug container 为 CPU、Memory、Network 等诊断提供目标容器当前不具备的权限和工具。交互执行时由用户按诊断
目的选择 `SYS_PTRACE`、`NET_RAW` 或两者；非交互执行保持同时申请两者。Ephemeral Container 必须已运行、进入
目标容器 PID namespace，并具备本次选择的 capability。GDB、Pydump、py-spy 和网络工具是建立在基础 container
上的能力，不再决定 `doctor debug` 本身是否成功。

`infra/target/debug` 定义目标侧 `DebugEngine`；Kubernetes Ephemeral Container 是当前的准备路线，
镜像访问由 `infra/image` 提供，底层资源读取和 mutation 复用 `infra/k8s`。调用方只消费
Debug Environment Fact 与 Preparation，不依赖具体准备路线。

## 流程

1. image tar 的 registry 发布与 Doctor Host 准备由 `doctor image` 独立完成，详见
   [`image.md`](image.md)；`doctor debug` 不参与该流程。
2. `doctor debug` 只消费已经可用的镜像：交互选择 registry 中的 doctor-debug image，或显式复用目标业务
   镜像；不读取本地 tar，也不执行 load、push 或其它镜像准备。
3. 用户选择复用业务镜像，或 doctor-debug image 不可用时自动回退，均使用 `Never` 复用目标 Node 已缓存的 image。
   Doctor 从已 Ready 的业务容器探测安全的 `sleep` 或 Python keepalive，并显式覆盖 ENTRYPOINT/CMD；没有安全
   常驻命令时停止，不启动第二份业务进程。临时容器 Running 后报告 GDB 等工具能力；若当前目录存在有效的
   `doctor-packages-*.tar`，交互执行会以这个具备 `SYS_PTRACE` 的新建容器为明确目标进入
   `doctor install gdb`。现有 GDB 满足能力契约时直接返回，确需写入时仍单独展示安装方案并取得确认。
4. Inspect 根据容器状态、PID namespace、工具和 capability 形成 Debug Environment Fact。`doctor mem` 使用 environment 前再次验证
   实际 ptrace attach 条件与 GDB inferior call，并在缺少 Pydump Collector 或 Agent 时取得
   attach 授权后按需上传。
5. Ephemeral Container 不能原地删除或替换，debug container 保留到 Pod 被替换；CPU/Memory/Network 各自验证
   所需能力，不把 ptrace-only container 误报为完整工具环境。

Network 同样只消费已就绪 Fact：debug container 启动后不自动抓包；`doctor net` 通过镜像内的抓包控制器显式创建
有超时和容量边界的 session，停止并回传完成后再按用户选择清理远端 artifact。`doctor debug --services`
只是单 Pod 准备流程的批量入口，仍不拥有任何抓包 session。

## 关键设计

### 准备能力与采集证据分开

镜像发布、临时容器 mutation 和 container capability 准备属于诊断准备；线程栈、内存 dump 等才是领域证据。
Probe 不在执行途中发布镜像或部署 debug container。Pydump Collector 与 Agent 是单个领域工具，
由 `doctor mem` 在 attach
授权后按需上传；GDB 及其动态依赖由独立的 `doctor install` 补齐，避免 debug 生命周期或 memory Probe
自行修改系统包。

### Fact 描述现实，不携带待执行动作

Debug Environment Fact 只说明候选环境是否 Ready、是否能进入目标 PID namespace、是否具备所需工具和 capability。
没有就绪 debug container 时 Probe 报告证据缺口，不把“创建一个”伪装成 Fact 或 Observation。

### mutation 统一经过 K8s 原语

RBAC 检查、server-side dry-run 与真实 mutation 使用同一份资源描述，减少预检与执行漂移。镜像属于
Doctor Toolkit，与其它诊断工具共享独立版本；具体 tag、工具版本和 readiness 字段属于代码事实，
不写进本设计文档。

Debug container 按用户选择具备进程 attach、网络抓包或临时 Pod 网络规则能力；已有容器按其实际能力被对应诊断复用。
Network 还必须额外验证抓包 capability、tcpdump 和控制器。容器 spec 中声明 capability 只是 Fact，真正能否
打开抓包 socket 仍由 `doctor net` 的 ARM 结果确认。

`NET_ADMIN` 仅用于 Service 显式允许的 heap-dump liveness 代理，不属于默认 capability。用户必须通过
交互项或 `--capabilities SYS_PTRACE,NET_ADMIN` 明确申请；Doctor mem 还会在写入临时 iptables 规则前
验证 debug container 工具与运行态权限，失败时不修改网络。

### 镜像发布与容器部署分离

tar 解析、registry 写入和 Doctor Host load 统一归 `doctor image`，完整流程见 [`image.md`](image.md)。
`doctor debug` 只读取已发布镜像或复用目标 Node 已有的业务镜像，不扫描本地 tar，也不持有 load/push 职责。
Debug image repository 名由代码中的单一常量同时约束构建和运行时解析；repository/tag 属于 registry 运行态，
交互式解析必须基于当前 Kubernetes namespace 的镜像位置组合读取候选并让用户确认，不能把目标 Pod 的
镜像 namespace 或当前 debug image 版本当成唯一可能的发布位置。
临时容器由 doctor 自动复用；若同一目标容器已有多个兼容候选，则选择 Pod 中最后加入的一个，
不再通过容器名参数让调用方介入选择。

### 无 registry 路线仍依赖临时容器授权

复制或安装 GDB、Pydump 只能补齐工具，不能为原业务容器补出 `SYS_PTRACE`。无 registry 路线仍创建进入目标
PID namespace 的 Ephemeral Container，并申请诊断所需 capability；若集群拒绝 `pods/ephemeralcontainers` 或
admission 拒绝 capability，命令在 mutation 前置检查处停止。目标业务镜像 fallback 显式覆盖 ENTRYPOINT/CMD；
`doctor debug` 不实现安装动作，只在新建容器后按本地 Toolkit/package tar 提供 `doctor install` 后续入口。在线和离线安装
统一由 [`install.md`](install.md) 描述的 `doctor install` 完成；离线程序包也不属于 doctor-debug image/tar。
