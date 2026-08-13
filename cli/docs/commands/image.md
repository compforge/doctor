# Image 准备

## 理念 / 概念

`doctor image` 是 Doctor 的 image tar 分发入口。它负责把显式/当前目录 image tar，或 Doctor Toolkit
中的 debug image 资源，按需准备到两个彼此独立的
位置，可只选一个，也可同时选择：

- **Target Registry**：供 Kubernetes Node 拉取并启动 doctor-debug 等镜像。
- **Doctor Host**：供 `doctor mema` 等本地隔离执行场景使用，通过 Docker、Podman 或 nerdctl load。

`doctor image` 不选择诊断 Pod，也不创建临时容器；`doctor debug` 只消费已经准备好的 registry image 或目标
Node 已有的业务镜像。这样 image 分发、Kubernetes mutation 和诊断证据采集拥有各自的权限与生命周期。

`src/provision/image.ts` 编排 tar、registry 和 Doctor Host 三段流程，`src/app/image-target.ts` 负责目标位置选择；
具体 registry 读写与本地 container engine 差异分别由 `infra/image` 和
`infra/host/container-engine` 收口。

## 流程

1. 优先使用显式 image tar；否则使用已发现 Toolkit 中的 debug image，最后从当前目录选择普通 image tar。
   唯一候选自动采用，多个候选交互选择，自动化调用可显式指定路径。
   选择单架构 tar 后，如果同目录存在同一 image/tag 的另一架构 tar，则自动配对；自动化调用可重复传入
   `--tar` 明确提供 amd64、arm64 两份材料。
2. 读取 Docker/OCI archive 的 image config 或 descriptor，确定 source image 及真实平台；tar 包含多个 image
   时由用户选择，自动化调用显式指定。
3. 选择落点：`--registry` 只发布 Target Registry，`--host` 只 load Doctor Host，两者同时传则准备两处。
   位置参数 `[image]` 始终表示 Registry 目标，因此 `[image] --host` 也会准备两处。不传落点 flag 时保留原有
   行为：先发布 Registry，再在交互终端询问是否同时 load Host；非交互调用可用 `-y/--yes` 确认这个附加 load。
4. 选择 Registry 时，确定目标 registry 和镜像 namespace，并保留 source image 的 repository/tag 组成发布
   目标。现有 Pod image 只用于提供候选；无法列举 Pod 或候选不合适时，允许直接手动输入完整目标位置。
5. 使用 profile 提供的 registry 凭据检查目标并 push。双架构材料先发布带 `-linux-amd64` /
   `-linux-arm64` 后缀的子镜像，再创建并验证无架构后缀的 OCI index；单架构材料保持原目标 tag。目标 tag
   已存在也重新发布，因为显式选择 Registry 表达的是本次 tar 应成为目标内容。
6. 选择 Doctor Host 时探测本地 container engine 并 load；双架构材料只选择与 Host 架构匹配的一份。
   显式 `--host` 已表达执行意图，不再二次确认；找不到 engine、架构不匹配或 load 失败时该落点失败，但不撤销
   已完成的 Registry 发布。

## 关键设计

### 两个落点独立选择、独立执行

Registry 和 Doctor Host 服务不同消费者，任一方都不作为另一方的前置。用户显式选择两个落点时，即使其中
一个未完成，也继续尝试另一个；最终退出状态反映显式选择的落点是否全部完成。未传落点 flag 的兼容流程仍把
Host load 作为 Registry 发布后的可选附加动作。

### 发现只提供候选，不成为权限前置

Doctor 读取现有 Pod image 的目的只是推导 registry 与镜像 namespace，不关心 Pod 本身。客户凭据没有
`list pods` 权限时，命令明确说明自动发现不可用并改为手动输入，不能因此阻断 image 发布。

### 两个 image 身份分别保留

registry 侧使用用户确认后的完整目标引用；Doctor Host load 保留 tar 内的 source image 身份。两者服务不同
消费者，不要求本地额外复制 registry tag。需要本地 analyzer 的命令按 image label 发现候选，不依赖发布目标名。

### Host 与 Target 平台分别决定

Target Registry 接收本地实际具备的平台材料：只有一份 tar 时发布对应的单平台 image；amd64、arm64
同时存在时才发布两个平台子镜像并创建原生 multi-arch tag，由 Kubernetes 按 Node 平台选择。Doctor Host load
独立按运行 Doctor 的 Host 架构选择，不能假设 Host 与 Target 架构一致。Linux 发行版不是 OCI image 的平台
选择维度：镜像携带自身用户态，Host/Target 的 `os-release` 不需要相同。依赖目标发行版的软件包安装兼容性
属于 `doctor install`，不进入 image 分发模型。

### Image 生命周期由所在位置拥有

Doctor 不自动删除或覆盖 Doctor Host 的其它 image，也不管理 registry retention。已有本地 source image 时直接
复用；需要 load 时完成后再次确认其可见性。后续清理分别由 container engine 和 registry 的运维策略负责。
