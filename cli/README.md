# Doctor CLI

Doctor 是面向应用与基础设施的诊断客户端。直接运行 `doctor` 查看能力索引，使用
`doctor <command> --help` 查看某条命令的参数。Plugin 命令始终可见；当前 Plugin 缺少 required
capability 时，CLI 会在访问环境前说明具体缺口。

## 本地构建

```bash
make build
```

通用临时诊断镜像在带 Docker Buildx 的 Linux/devbox 上单独构建。聚合 target 同时构建
`linux/amd64` 和 `linux/arm64`，一个架构对应一个 image tar：

```bash
make build-debug-images
# 指定 tar 内 doctor-debug 镜像的 tag；默认读取 docker/debug/VERSION
make build-debug-images DOCTOR_DEBUG_TAG=0.0.10
```

产物为 `dist/doctor-debug-linux-amd64.tar` 和 `dist/doctor-debug-linux-arm64.tar`，与 doctor binary 一起交付但不纳入 Git、不嵌入 executable。`make build` 产出的每个平台 Doctor 单文件只内嵌匹配 OS/arch 的 regctl，客户不需要额外分发 regctl，也不强制要求本机 container engine。`doctor image [registry/namespace/image:tag]` 是 image tar 的唯一准备入口：从当前目录选择 tar，可用 `--registry` 发布到指定 registry/namespace、用 `--host` load 到 Doctor Host，或同时准备到两处。`doctor debug` 只消费已发布的 doctor-debug image，或在其不可用时复用目标 Pod 已有的业务镜像，不处理 tar 和镜像发布。

Debian 12 的 GDB 离线安装包同样独立构建：

```bash
make build-gdb-package-bundles
# 默认读取 package-bundles/VERSION，也可显式覆盖
make build-gdb-package-bundles DOCTOR_PACKAGE_BUNDLE_VERSION=0.0.1
```

对外交付产物为单个版本化文件
`dist/doctor-packages-<version>-debian12.tar`。它聚合不同架构、包版本和 Target kernel
兼容范围的内部 variant；版本独立于 Doctor CLI 和 debug image。`doctor install` 在运行期只提取并
上传与 Target 匹配的 variant。单架构 v1 variant 仍可通过
`make build-gdb-package-linux-amd64` / `make build-gdb-package-linux-arm64` 独立构建验证。

## 命令

| 命令 | 用途 |
|---|---|
| `doctor chat` | 进入交互式 AI 问诊 |
| `doctor cpu` | 对目标 Pod 做 Python CPU、卡顿与线程栈取证 |
| `doctor mem` | attach 目标 Python 进程，通过已有 debug container 或已具备 GDB 前置的业务容器生成并回传 PyHeap |
| `doctor mema [inputs...]` | 在 Doctor Host 解析、缓存并诊断 PyHeap；本机 Python 不兼容时用已加载的 doctor-debug container |
| `doctor image` | 将当前目录的 image tar 按需准备到 Target Registry、Doctor Host 或两处 |
| `doctor debug` | 为目标 Pod 启动或复用 ptrace 临时容器；debug image 不可用时复用业务镜像 |
| `doctor install` | 交互选择并向目标 Pod container 安装 GDB，在线源失败时尝试 Doctor 离线包 |
| `doctor trace` | 从 OpenSearch 下载 trace 并生成逻辑节点树 / 火焰图 HTML；bundle 模式保留原始 span |
| `doctor store` | 从 Service Pod 获取凭据，一次选择一个或多个 DB、VDB、S3、Redis 诊断；S3 同时统计前缀和对象年龄 |
| `doctor log --biz-id <id>` | 通过 Plugin traceId capability 解析 trace ID，再聚合服务日志 |
| `doctor data --biz-id <id>` | 先扩展业务 ID，再按 Service Catalog 汇集各服务声明的数据 |
| `doctor http` | 从 YAML 重放一个或多个 HTTP 请求，多轮采集并分析响应 |
| `doctor model` | 从模型目录选择目标，执行 validation/inference，并可选进行流式性能采样 |
| `doctor metric` | 使用 profile 中的 Prometheus，或临时抓取 Service `/metrics`，执行业务 detector 并生成离线 HTML 图表 |
| `doctor net` | 协调多个 Service Pod 短时抓包；选择 YAML 跟踪已知请求，或守候页面操作产生的请求 |
| `doctor neta [input]` | 纯离线分析 NetBundle，生成业务调用 Diagnosis 的 Markdown、泳道/瀑布 HTML 与结构化 JSON |
| `doctor version` | 显示版本和当前平台 |
| `doctor help` | 显示命令帮助 |

## 详细文档

- [CLI Kernel 与 Collect 共享协议](docs/kernel.md)
- [Config 诊断](docs/command/config-diagnosis.md)
- [Metric 诊断](docs/command/metric-diagnosis.md)
- [Memory 诊断](docs/command/memory-diagnosis.md)
- [CPU 诊断](docs/command/cpu-diagnosis.md)
- [Log 采集](docs/command/log-diagnosis.md)
- [Data 汇集诊断](docs/command/data-diagnosis.md)
- [Trace 采集](docs/command/trace-diagnosis.md)
- [Store 诊断](docs/command/store-diagnosis.md)
- [MCP 诊断](docs/command/mcp-diagnosis.md)
- [Model 诊断](docs/command/model-diagnosis.md)
- [Image 准备](docs/command/image.md)
- [Debug container](docs/command/debug-container.md)
- [Container GDB 安装](docs/command/install.md)
- [HTTP 场景重放与诊断](docs/command/http-diagnosis.md)
- [Network 抓包与离线分析](docs/command/network-diagnosis.md)
