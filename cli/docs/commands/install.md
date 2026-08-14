# Container GDB 安装

## 理念 / 概念

`doctor install` 交互询问用户要安装的程序，并向选定的 Pod container 临时安装。首版候选只有 GDB。
非交互调用通过 `--program gdb` 明确指定。目标可以是业务 container，也可以是
Ephemeral Container；命令不替用户判断应该修改哪一个。安装会直接改变目标 container 的可写层，Pod
重建后结果消失，因此执行前必须展示目标和影响并取得确认。

APT、APK、DNF、microdnf 和 YUM 是 `infra/target/package-install` 中的实现适配器，不进入命令名称。
`doctor debug` 只管理 debug Ephemeral Container，不承担软件安装；新建容器后发现当前目录存在有效 package tar
时，可以把这个精确目标交给独立的 `doctor install` 流程。

## 流程

实现按 `Inspect → Plan → Apply → Verify` 单向推进：Inspect 只形成 Target 与分发包 Facts，Plan
确定唯一的在线、离线或不支持路径，Apply 才允许修改 Container，Verify 负责安装前短路和安装后能力验收。
它借鉴 Collect 的 Facts 单向流，但不复用 Evidence、Detector 或 Probe 语义。

1. 选择 Namespace、Pod 和目标 Container；非交互环境通过参数明确提供。
2. 交互选择待安装程序；非交互环境要求 `--program`，首版仅接受 GDB。
3. 探测目标 OS、架构、Linux kernel 和包管理器；现有 GDB 通过 inferior function call 验收后
   直接返回，不产生写操作。Python scripting 能力只作为兼容性事实记录，不是 Pydump 的前置条件。
4. 展示将修改的 Container、软件源访问和资源影响，取得用户确认。
5. 从 `--tar` 或当前目录的 `doctor-packages-*.tar` 中读取 package set，按发行版、架构、Target
   kernel 兼容范围和 GDB 版本选择内部 variant。显式指定或带 kernel 兼容声明的 variant 直接使用；
   否则优先使用 Container 已配置的软件源，在线安装失败或能力验收不通过时再使用匹配 variant。
6. 上传离线包到目标 Container 的临时目录，通过独立的本地 APT source 安装，完成后删除上传的 tar。
   在线或离线安装完成后先使用发行版包数据库确认安装结果，再运行不 attach 业务进程的 GDB
   inferior call smoke test；通过后才算安装成功。

## 关键设计

### 安装目标由用户显式选择

独立执行 `doctor install` 时，目标始终由用户选择。`doctor debug` 创建新容器后的后续入口只传递刚创建的
精确目标，不复用其它临时容器；终端仍打印 `pod/<pod> container/<container>`，并在实际写入前单独确认，
避免用户授权对象和实际修改对象不一致。只读 root filesystem、非 root 身份或包管理器不可用时，安装自然
失败并报告原始原因，不尝试 rollout 或替换工作负载。

### 单文件分发，variant 运行期选择

对外交付的 package set 是一个版本化 tar：

```text
doctor-package-set/
├── manifest.json
└── variants/
    ├── <platform>-<gdb-version>-<variant>.tar
    └── ...
```

外层 manifest schema 为 `doctor-package-set/v1`，记录 set 版本，并为每个 variant 保存路径、
SHA-256 和完整的 v1 manifest。Doctor 先探测 Target，再从同一个分发文件中选择 variant；选中后在
Doctor Host 临时提取、校验并只上传该 variant，安装完成后清理临时文件。分发侧始终只有一个 tar，
Target 不接收与自身无关的平台或 GDB 版本。

### 内层离线仓是 Doctor v1 协议

首版离线安装覆盖 Debian/APT。每个内部 variant 使用以下稳定布局：

```text
doctor-packages/
├── manifest.json
└── repo/
    ├── Packages 或 Packages.gz
    └── *.deb
```

内层 `manifest.json` 的 schema 为 `doctor-packages/v1`，基础字段记录 `bundleVersion`、`packageManager`、
`osId`、`osVersionId`、`architecture` 和 `packages`；`packageVersions` 记录实际 GDB 包版本，
`compatibility.kernel` 可声明 `minInclusive` / `maxExclusive`。Doctor 同时匹配发行版、主版本、
架构、包管理器和 kernel 范围，并要求 bundle 包含 GDB；多个候选都匹配时优先选择声明 kernel
范围的 bundle，再选择更高 GDB 版本。不能只按 `linux/amd64` 跨 Debian 版本复用。tar 只允许
`doctor-packages/` 下的相对路径，解包前拒绝绝对路径和 `..` 条目，并拒绝 symlink、hardlink 等特殊条目。

kernel 范围是 package bundle 的已验证兼容性声明，不由 Doctor 根据 kernel 主版本猜测 GDB 版本。
构建已验证的专用 bundle 时可设置 `DOCTOR_KERNEL_MIN_INCLUSIVE` 与
`DOCTOR_KERNEL_MAX_EXCLUSIVE`；没有声明范围的历史 bundle 仍可读取，但不会覆盖更具体的候选。

离线 package 是 Doctor Toolkit 的平台资源，与 debug image 和诊断 executable 共享 `toolkit/VERSION`，
独立于 Doctor CLI。Toolkit manifest 负责记录每项资源的平台、路径、大小与 SHA-256。

### 包文件从哪里来

Package bundle 最终仍是一个本地 APT 源，里面只有标准 `.deb`、`Packages` 索引和 Doctor
manifest。包文件分为两类：

1. GDB 主包：Debian 12（含 bookworm-backports）只提供 GDB 13.1，未满足已复现环境中的
   attach-call 能力契约。Doctor 从固定版本、固定 SHA-256 的 GNU GDB 官方源码构建 17.2，并在
   Debian 12 目标架构环境中封装为 `gdb` Debian 包。这样获得新版 GDB，同时保持 Debian 12 的
   glibc/Python ABI。
2. 运行依赖：构建阶段把上述 GDB 包加入临时本地 APT 源，再由 Debian 12 官方 APT 源解析并下载
   完整依赖闭包。随后用这些 `.deb` 生成 flat repository，聚合进对应架构的 variant。

因此“源码构建”只用于生成官方 APT 缺失的新版 GDB 主包，不发生在客户环境。客户拿到的是普通
APT 包集合：Doctor 只上传匹配 Target 的 variant，通过临时 SourceList 和 `file:` source 离线安装；
不修改 Container 的 `/etc/apt/sources.list`，不访问 registry，也不要求现场安装编译工具或编译 GDB。
该 `file:` source 仅在本次已校验的 Doctor bundle 上使用。

Debian 12 bundle 在 Debian 12 构建环境中从官方源码编译 GDB 17.2，再封装为自定义 Debian 包；
不会混入依赖更高版本 glibc/Python 的其它 Debian release 二进制包。源码版本与 SHA-256 固定在构建脚本中，
可分别通过 `DOCTOR_GDB_VERSION`、`DOCTOR_GDB_SHA256` 显式覆盖。通过以下命令构建：

```bash
make -C toolkit build OS=linux ARCH=amd64
make -C toolkit build OS=linux ARCH=arm64
```

构建过程使用 Docker 或 Podman 分别运行目标架构的 Debian 12，并在全新的 slim root 中只使用生成的
本地 source 安装并验证 GDB 可执行。构建过程同时把发行版实际解析到的 GDB 包版本写入
内层 manifest，再作为对应 Linux/arch Toolkit slice 的 package 资源交付。

可用 `DOCTOR_CONTAINER_ENGINE=podman` 或 `DOCTOR_CONTAINER_ENGINE=docker` 显式选择构建引擎。

### 在线与离线共享同一次授权

授权同时说明在线软件源访问和可能的离线 tar 上传，避免在线失败后重复询问。离线包不是通用依赖求解器：
bundle 必须包含目标程序及其所需依赖；不匹配或依赖不全时停止，不混用客户不可达的软件源补齐。

### 安装成功按能力验收

GDB 包存在不等于 inferior call 能力可用。`doctor install --program gdb` 还会由 GDB
attach Doctor 自建的短生命周期 Python 进程并调用一个 inferior function；这能覆盖 GDB 启动新进程
无法暴露、只在 attach 后出现的 Target kernel 寄存器状态兼容问题。smoke test 不选择业务 PID。
Pydump 自动探测 GDB，不可用时使用独立的 `pydump-loader`；其 Collector、`pydump-loader`、Agent、
可写目录和实际业务 PID ptrace 条件由 `doctor mem` 在采集前联合探测。

客户环境中的 GDB 或 Doctor package bundle 不匹配时，可把兼容性现场保存为 Markdown 或 JSON：

```bash
doctor install \
  --program gdb \
  --pod <pod> \
  --container <debug-container> \
  --format md \
  --output doctor-install-gdb.md
```

报告 schema 为 `doctor.install-compatibility/v1`，记录 Target 的发行版、架构、kernel、glibc、Python、
CPU flags/features、容器 CapEff/Seccomp/Yama ptrace 状态，安装前后的 GDB Python scripting 事实和
inferior call 验收结果，以及当前目录或显式 package set 中全部 candidate manifest。失败报告保留
attach-call 原始错误和可直接搜索的组合关键词；JSON 适合自动化收集，Markdown 适合人工流转。
