# Doctor

[English](README.md) | [简体中文](README_CN.md)

> 懂业务的 Kubernetes 应用诊断工具。

Doctor 是面向应用排查的增强版 `kubectl`：理解一个应用由哪些 Service 组成，访问它们的运行实例，
把原始证据和离线报告交付回本机。Plugin 提供应用的 Service 目录与业务知识，Core 提供通用诊断工具。

## 从部署到问题排查

| 什么时候 | 命令 | 得到什么 |
|---|---|---|
| 部署后、开始承接业务前 | `doctor health` | 主动验证服务启动、依赖连通性和基本业务功能 |
| 系统运行一段时间后 | `doctor overview` | 查看时间窗口内的错误、诊断与耗时分布，按需选取代表样本 |
| 发现问题，需要排查时 | `doctor collect` | 汇集相关配置、业务数据、Trace、Log 和 Metric，交付证据包 |

按当前问题选择入口，也可以直接使用 `inspect`、`trace`、`log`、`data` 等命令聚焦某类信息；
CPU、内存和网络问题有对应的专项工具。完整思路见[排查主线](cli/docs/kernel.md#排查主线)。

```bash
doctor health --scope self,deps
doctor overview --since 1h
doctor collect <biz-id> --include data,trace,log
```

可执行的检查和可取得的数据由当前 Plugin 与目标访问权限决定。用 `doctor plugin` 查看 Service 目录，
用 `doctor <command> --help` 查看参数；会改变目标环境的操作需确认。

## 构建与开始使用

环境要求：[Bun](https://bun.sh/) 和 Go。在仓库根目录执行：

```bash
make deps
make build-local
./dist/doctor --help
```

`make build-local` 构建本机 macOS 产物，`make build` 构建各平台产物到 `dist/`。
使用已内置应用 Plugin 的发行版，或按 [Plugin 指南](cli/docs/plugin.md) 接入自己的应用。
开发检查使用 `make lint-all` 与 `make test-all`。

## 进一步阅读

- [CLI 使用与构建选项](cli/README.md) · [自定义发行版](cli/docs/distribution.md)
- [Health](cli/docs/commands/health.md) · [Overview](cli/docs/commands/overview.md) · [Collect](cli/docs/commands/collect.md)
- [Plugin 契约](cli/docs/plugin.md) · [Plugin 示例](plugins/example) · [Toolkit](toolkit/README.md)
- [Kernel 与证据流程](cli/docs/kernel.md) · [Chat](docs/chat.md) · [仓库地图](AGENTS.md)
