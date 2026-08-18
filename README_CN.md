# Doctor

[English](README.md) | [简体中文](README_CN.md)

> 懂业务的 Kubernetes 应用诊断工具。

Doctor 可以理解为一个增强版 `kubectl`。`kubectl` 理解 Kubernetes 对象；Doctor 还理解一个应用由
哪些 Service 组成、每个 Service 能提供哪些诊断数据，以及取得这些数据需要什么访问权限。

Doctor 以本地 CLI 运行在目标环境中，通过受限的 Kubernetes 和业务访问能力进入现场，再把原始证据
和离线报告交付回本机。

![Doctor 现场使用方式](docs/doctor-usage.svg)

## Doctor 能诊断什么

Doctor 从通用基础设施信号逐步深入到业务行为：

| 领域 | Doctor 关注的问题 |
|---|---|
| 可观测性 | 所选 Service 的 Trace、Metric 和 Log |
| 运行时 | Pod、Container 和 Process 的 CPU、内存与网络行为 |
| 业务数据 | Service Capability 暴露的业务数据、配置和存储 |
| 主动探测 | 为复现问题而受控触发的 HTTP 请求或其它业务动作 |
| 性能 | 只在一定压力下出现的问题，并把请求与 Trace、Metric、Log 关联起来 |
| Agent 应用 | Model 和 MCP 的配置、连通性、调用结果与服务端证据 |

有些诊断需要的工具或权限并不存在于业务容器中。`doctor image`、`doctor debug` 和 `doctor install`
可以显式准备诊断镜像、临时调试环境或工具，再开始采集；任何可能改变目标环境的操作都会先展示并确认。

## Doctor 如何理解业务

一个应用由一组 Service 组成。每个 Service 可以通过 Capability 声明自己能提供的数据、Metric、Log、
HTTP Case、Model、MCP Server 或其它业务诊断能力，同时声明运行这些能力前需要准备的目标数据和访问权限。

通用的 Kubernetes 访问、采集、证据和报告能力沉淀在 Doctor Core；版本化 Plugin 则提供 Service
Catalog 和业务 Capability，让私有协议与 Schema 留在业务侧，而不是进入开源 CLI。

Doctor 由此支持两类问题：

- 对于确定性问题，领域命令采集证据、执行可重复检查并生成离线报告。可复用能力沉淀到 Core，业务
  特有能力沉淀到 Plugin。
- 对于开放式问题，`doctor chat` 组合模型、受限工具和当前 Plugin 的 Skill，让诊断对话使用同一份
  业务知识继续排查。

## 仓库结构

| 路径 | 用途 |
|---|---|
| `cli/` | Doctor Core CLI、Collector、Evidence 模型与离线报告 |
| `toolkit/` | 独立版本的诊断工具、debug image 与离线系统软件包 |
| `server/` | 可选 Doctor server 的宿主边界 |
| `packages/agent/` | 本地 Chat 与 server host 共用的 Agent runtime |
| `packages/plugin/` | Plugin、Service 和 Capability 公共契约 |
| `plugins/example/` | 最小且业务中立的 Plugin 示例 |

## 开发

环境要求：[Bun](https://bun.sh/) 和 Go。

```bash
bun install
bun run typecheck:plugin-sdk
bun run typecheck:agent
bun run typecheck:example-plugin
bun run typecheck:cli
bun run test:plugin-sdk
bun run test:agent
bun run test:cli
```

构建所有平台的二进制到 `dist/`：

```bash
make build
```

只构建本机 macOS 二进制：

```bash
make build-local
```

按单个平台、平台矩阵或大一统归档构建 Toolkit：

```bash
make -C toolkit build OS=linux ARCH=arm64
make -C toolkit build-matrix
make -C toolkit build-all
```

Core 不再内嵌 Toolkit 可执行文件。把匹配的 `doctor-toolkit-*.tar` 放在 Doctor 同目录或当前工作目录；
大一统归档可同时服务平台不同的 Doctor Host 与 Kubernetes Target。

要让 Doctor 理解一个具体应用，可以从 [`plugins/example`](plugins/example) 开始，实现描述其 Service、
Capability 和 Skill 的 Plugin。

更深入的设计说明见 [`cli/docs/kernel.md`](cli/docs/kernel.md)、
[`cli/docs/plugin.md`](cli/docs/plugin.md) 和 [`docs/chat.md`](docs/chat.md)。
