# CLI assets

这里存放 doctor 构建需要的第三方资产。CPU 的 py-spy、GDB 与 PyHeap dumper 进入临时诊断镜像；Doctor CLI 也内嵌 PyHeap dumper/analyzer，分别用于目标容器 fallback 和本地分析。镜像 tar 输出到 `dist/`，不纳入 Git。

## py-spy

- 版本：`0.4.2`
- 来源：官方 GitHub Release 的 Linux manylinux wheels
- 覆盖：`x86_64`、`aarch64`
- 形态：从 wheel 提取静态链接的 `py-spy` 后 gzip；仅作为 `docker/debug/Dockerfile` 的镜像 build input，不嵌入 doctor executable
- 完整性：镜像构建时运行 `/opt/doctor/bin/py-spy --version`，发布交付时随镜像 tar 记录 SHA-256
- 许可证：`py-spy/py-spy-LICENSE.txt`

## PyHeap

- 版本：`0.7.0+doctor.2`
- 来源：`qiankunli/pyheap@0fa946c`（PR #4，目标 `release`），基于官方 `ivanyu/pyheap@v0.7.0` 增加 `--no-attribute`、`pyheap.analysis/v1` JSON 分析协议、retained owner 画像和 lite heap UI 兼容
- 覆盖：目标为 Linux CPython 3.8–3.12；dumper 运行处需要 gdb 与可写 `PEX_ROOT`，analyzer 只读取已生成的 `.pyheap`
- 形态：dumper 与 analyzer 分别构建为 PEX gzip；两者既是 `docker/debug/Dockerfile` 的 build input，也嵌入 Doctor 单文件。运行时解压到权限受限的本机临时目录：dumper 仅在目标容器已满足 GDB/ptrace 前置时临时上传，analyzer 只在 Doctor 本机读取 `.pyheap`
- 完整性：dumper gzip SHA-256 `7cbbbf5311167b2f9266d9b137db39e6fa9764af2e5128ffbd8ccc18be2ca5e3`，解压后 PEX SHA-256 `0e47be5666eaab966d83ce5c7c45fff75cf2c0f41888d3ec5b338c71ecd614e3`；analyzer gzip SHA-256 `42fa29f9d2206f21b4c025e25a7cf30c1561b3f54764e0e95f01cfc3de1b2578`，解压后 PEX SHA-256 `e33d140d5fcdce2dfbb456c59de8787da60317629b02ddf8475a958673a4537f`
- 许可证：`pyheap/pyheap-LICENSE.txt`；上游源码 tag 为 `ivanyu/pyheap@v0.7.0`

## regctl

- 版本：`0.11.5`
- 来源：官方 `regclient/regclient` GitHub Release
- 覆盖：`darwin/amd64`、`darwin/arm64`、`linux/amd64`、`linux/arm64`
- 形态：原始静态 binary 存放在 `assets/regctl/`；`make build-*` 只把匹配目标 OS/arch 的一份嵌入对应 Doctor 单文件，运行时解到权限受限的临时目录执行并在退出时清理
- 用途：`doctor debug` 直接访问 OCI registry，完成 manifest 探测、Docker archive 导入与 multi-arch index 创建，不依赖 Docker/Podman daemon
- SHA-256：
  - `regctl-darwin-amd64`: `c132fdddda68b9c7584ac19f3b40cd17f71916c2bca8182270ebe65b55198a12`
  - `regctl-darwin-arm64`: `f4d536d64d0c3cc1db7400902175a1c314675991d22e87e15c319501a2676d3f`
  - `regctl-linux-amd64`: `c93aa7638749f5aaac1a8e01787321889c78f0101809bb2880343478d0ba0467`
  - `regctl-linux-arm64`: `c4cf231e74cda685f1599f3d866b02b03c572e54b79ec8b062f32070b0ba4587`
- 许可证：Apache-2.0，见 `regctl/regclient-LICENSE.txt`

## doctor-pcap / gopacket

- 版本：`doctor-pcap 0.1.0`，依赖 `gopacket/gopacket v1.7.0`
- 来源：仓库内 `src/infra/host/network-analysis/gopacket` 源码构建
- 覆盖：`darwin/amd64`、`darwin/arm64`、`linux/amd64`、`linux/arm64`
- 形态：`CGO_ENABLED=0` 静态 helper；`make build-*` 构建对应平台后嵌入 Doctor 单文件，运行时解到权限受限的临时目录并在退出时清理
- 用途：当分析机没有 tshark 时，为 `doctor neta` 提供 PCAP、TCP 重组、明文 HTTP/1 与连接终止事件的确定性解析基线
- 许可证：BSD-3-Clause，见 `gopacket/gopacket-LICENSE.txt`

## doctor debug image

- 基础镜像：Docker Hub 官方 `alpine:3.22.5`
- 覆盖：`linux/amd64`、`linux/arm64`
- 内容：sh、Python 3、启用 Python scripting 的 GDB、py-spy 0.4.2、Austin 4.0.0，以及 PyHeap dumper / analyzer 0.7.0+doctor.2
- 覆盖：`linux/amd64`、`linux/arm64`；Austin 从固定 tag 源码在 Alpine/musl 上构建，不受业务容器 glibc 版本约束
- 形态：`dist/doctor-debug-<version>-linux-<arch>.tar`，一个架构一个 tar；与 doctor binary 并列交付，不嵌入 executable
- 体积：devbox amd64 实建镜像约 70.4 MiB，Docker archive 约 72.5 MiB；基础镜像与 apk 版本变化时会小幅漂移
- 版本：独立版本源为 `docker/debug/VERSION`，变更记录见 `docker/debug/RELEASE.md`
- 构建：在带 Docker Buildx 的 Linux/devbox 上执行 `make build-debug-images`；可用 `DOCTOR_DEBUG_TAG=<tag>` 覆盖默认的 debug image 版本
- 使用：`doctor image --registry <registry/namespace/image:tag>` 发布到 Registry，`doctor image --host` load 到 Doctor Host；两个落点可组合，`doctor debug` 不读取或分发 tar
- 完整性：发布交付时为实际 tar 生成并记录 SHA-256

升级资产时必须同时更新版本、目标架构、完整性信息和许可证，并运行 CLI typecheck、测试及四平台构建。
