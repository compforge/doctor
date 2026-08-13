# Doctor CLI

Doctor 是面向应用与基础设施的诊断客户端。直接运行 `doctor` 查看能力索引，使用
`doctor <command> --help` 查看某条命令的参数。Plugin 命令始终可见；当前 Plugin 缺少 required
capability 时，CLI 会在访问环境前说明具体缺口。

## 本地构建

```bash
make build
```

Doctor CLI 不内嵌 `regctl`、`doctor-pcap`、Pydump 等诊断工具。Pydump Injector、GDB 等可选组件与
debug image 统一由根目录 `toolkit/` 独立版本和构建；具体命令只准备自己选择的采集路线所需组件：

```bash
make -C ../toolkit build OS=linux ARCH=arm64
make -C ../toolkit build-matrix
make -C ../toolkit build-all
```

`doctor-toolkit-<version>-<os>-<arch>.tar` 是单平台切片，`doctor-toolkit-<version>-all.tar` 同时包含全部
平台。平台表示资源的实际执行位置：同一次命令可以为 Doctor Host 选择 Darwin/ARM64 工具，同时为 Pod
选择 Linux/AMD64 工具。把 Toolkit tar 放在 Doctor 可执行文件旁或当前目录即可；也可用
`DOCTOR_TOOLKIT=<path>` 显式指定。`doctor image` 从 Toolkit 取得 debug image，`doctor install` 从中取得
匹配 Target 发行版和架构的离线包。

## 命令

| 命令 | 用途 |
|---|---|
| `doctor chat` | 进入交互式 AI 问诊 |
| `doctor cpu` | 对目标 Pod 做 Python CPU、卡顿与线程栈取证 |
| `doctor mem` | 探测目标 CPython/libc，选择兼容 Pydump Agent，attach 后生成并回传对象堆 |
| `doctor mema [inputs...]` | 在 Doctor Host 用独立 Go analyzer 解析、缓存并诊断 Pydump artifact |
| `doctor image` | 将当前目录的 image tar 按需准备到 Target Registry、Doctor Host 或两处 |
| `doctor debug` | 为目标 Pod 启动或复用 ptrace 临时容器；debug image 不可用时复用业务镜像 |
| `doctor install` | 交互选择并向目标 Pod container 安装 GDB，在线源失败时尝试 Doctor 离线包 |
| `doctor trace` | 从 OpenSearch 下载 trace 并生成逻辑节点树 / 火焰图 HTML；bundle 模式保留原始 span |
| `doctor store` | 从 Service Pod 获取凭据，一次选择一个或多个 DB、VDB、S3、Redis 诊断；S3 同时统计前缀和对象年龄 |
| `doctor log --biz-id <id>` | 通过 Plugin traceId capability 解析 trace ID，再聚合服务日志 |
| `doctor data --biz-id <id>` | 先扩展业务 ID，再按 Service Catalog 汇集各服务声明的数据 |
| `doctor config` | 展示 Service Pod、Toolchain 和配置对照，并可选采集 Deployment 配置与应用依赖 |
| `doctor http` | 从 YAML 重放一个或多个 HTTP 请求，多轮采集并分析响应 |
| `doctor model` | 从模型目录选择目标，执行 validation/inference，并可选进行流式性能采样 |
| `doctor metric` | 使用 profile 中的 Prometheus，或临时抓取 Service `/metrics`，执行业务 detector 并生成离线 HTML 图表 |
| `doctor net` | 协调多个 Service Pod 短时抓包；选择 YAML 跟踪已知请求，或守候页面操作产生的请求 |
| `doctor neta [input]` | 纯离线分析 NetBundle，生成业务调用 Diagnosis 的 Markdown、泳道/瀑布 HTML 与结构化 JSON |
| `doctor version` | 显示 Doctor、当前平台及嵌入 Plugin 的精确版本 |
| `doctor help` | 显示命令帮助 |

## 详细文档

- [CLI Kernel 与 Collect 共享协议](docs/kernel.md)
- [Config 诊断](docs/commands/config-diagnosis.md)
- [Metric 诊断](docs/commands/metric-diagnosis.md)
- [Memory 诊断](docs/commands/memory-diagnosis.md)
- [CPU 诊断](docs/commands/cpu-diagnosis.md)
- [Log 采集](docs/commands/log-diagnosis.md)
- [Data 汇集诊断](docs/commands/data-diagnosis.md)
- [Trace 采集](docs/commands/trace-diagnosis.md)
- [Store 诊断](docs/commands/store-diagnosis.md)
- [MCP 诊断](docs/commands/mcp-diagnosis.md)
- [Model 诊断](docs/commands/model-diagnosis.md)
- [Image 准备](docs/commands/image.md)
- [Debug container](docs/commands/debug-container.md)
- [Container GDB 安装](docs/commands/install.md)
- [HTTP 场景重放与诊断](docs/commands/http-diagnosis.md)
- [Network 抓包与离线分析](docs/commands/network-diagnosis.md)
