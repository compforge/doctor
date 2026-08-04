# Doctor package bundles Release Notes

版本号单一来源是同目录的 `VERSION`，独立于 Doctor CLI 和 doctor debug image。构建时把版本写入
对外交付的 `doctor-package-set/v1` manifest；内部 variant 继续使用 `doctor-packages/v1`。

## 0.0.4

- Debian 12 variant 不再打包发行版自带的 GDB 13.1；改为在 Debian 12 基础环境中从官方源码构建
  GDB 17.2，保持目标 glibc/Python ABI 不变，并修复新 kernel 上 attach 后读取扩展寄存器状态失败的问题。
- 源码 tar 使用固定 SHA-256 验证；生成的自定义 Debian 包继续进入现有 flat APT repository，
  安装流程与 `doctor-packages/v1` 协议不变。

## 0.0.3

- 对外交付物收敛为单个版本化 package set；一个 tar 可包含不同架构、GDB 版本与 kernel 兼容范围的
  v1 variant。
- `doctor install` 先按 Target 事实选择 variant，仅在运行期临时提取并上传选中的内层 bundle。
- package set manifest 记录每个 variant 的 SHA-256，提取后再次核对内层 manifest。

## 0.0.2

- manifest 增加实际包版本，并可声明已验证的 Target kernel 兼容范围，供 `doctor install` 在多个
  GDB bundle 之间自动选择。
- 离线安装允许按 manifest 的精确版本降级 GDB，避免在线源已安装的不兼容高版本阻止切换。

## 0.0.1

- 首版提供 Debian 12 的 GDB 离线 APT 仓，覆盖 `linux/amd64` 与 `linux/arm64`。
- 构建时在全新的 Debian slim root 中只使用生成的本地 source 安装 GDB，并验证 GDB Python scripting。
