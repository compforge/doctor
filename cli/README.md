# Doctor CLI

Doctor 是面向应用与基础设施的诊断客户端。直接运行 `doctor` 查看能力索引，使用
`doctor <command> --help` 查看某条命令的参数。默认显示全部命令；当前 Plugin 缺少 required
capability 时，CLI 会在访问环境前说明具体缺口。

## 选择 Kubernetes 环境

`--kubeconfig` 与 `--context` 是全局选项，根 Help 和子命令 Help 都会展示。参数可放在子命令前后：

```bash
doctor --kubeconfig /path/to/config --context staging inspect --services api -n app
doctor inspect --kubeconfig /path/to/config --context staging --services api -n app
```

显式 `--kubeconfig` 优先于 profile 的 `kube.kubeconfig_path`；同一选项重复传入时最后一个生效。
这些参数只在命令需要 Kubernetes 时使用，查看 Help 或 `plugin` 列表不连接目标环境。
`--config` 仍表示 Doctor 的配置文件，与 kubeconfig 不同。

## 本地构建

```bash
make build
```

默认内嵌运行时，接收方无需安装 Node。已有 Node >= 22.23.1 时可交付不带运行时的 bundle：

```bash
make build BUNDLE_RUNTIME=false
# 或从仓库根目录：make build-local BUNDLE_RUNTIME=false
./dist/doctor --help
```

无运行时模式输出 `doctor` 启动脚本与 `doctor.mjs`，两者必须放在同一目录；应用依赖已打包，客户无需
安装 npm 包。`make install BUNDLE_RUNTIME=false` 会安装这两个文件。该开关独立于 Plugin 和命令展示，
不改变业务能力授权，也不改变 Toolkit 的单独交付约定。

构建时可用 `DOCTOR_COMMANDS` 指定帮助中可见的顶层命令，逗号分隔，默认 `all`：

```bash
make build-mac DOCTOR_COMMANDS=inspect,data,trace,log
# 从仓库根目录构建：
make -C .. build-local DOCTOR_COMMANDS=inspect,data,trace,log
```

`help`、`version` 始终可见。其它命令使用 Commander 的 `hidden` 标记隐藏，仍可直接调用并查看
自身的 `--help`；此选项不禁用功能、不裁剪代码，也不是权限边界。拼错命令名会使构建失败。
可见性写入 Bun executable 与 Node SEA 产物，运行时设置同名环境变量不会改变它。

Doctor 也支持以独立名称交付的[发行版](docs/distribution.md)：发行入口可以配置名称、描述和默认命令展示，
并独立选择内置 Plugin；没有发行配置时保持原生 Doctor 行为。

Doctor CLI 不内嵌 `regctl`、`doctor-pcap`、fork-pyheap 等诊断工具。fork-pyheap dumper、GDB 等
可选组件与 debug image 统一由根目录 `toolkit/` 独立版本和构建；具体命令只准备本次诊断所需组件：

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

用 `doctor plugin` 离线查看当前生效的 Plugin、版本、加载来源及其声明的 Service。
`doctor plugin --format json` 返回 `{ "plugins": [...] }`，每个 Service 包含 `name`、
`capabilities` 和 `contributions` 名称数组，以及可选说明和 `details` 诊断声明。
用 `doctor plugin --service <name>` 查看一个逻辑 Service 的输入 ID、可能产出、限制、Workload 与依赖；
加 `-f json` 可供 Agent 读取同一份结构化详情。例如提取可传给 `inspect --services` 的名称：

```bash
doctor plugin --format json | jq -r '.plugins[].services[].name'
```

入口注入的 Plugin 优先于本机激活版本；没有生效 Plugin 时列表为空。输出是 Catalog 声明，
不表示目标环境中的服务已部署、健康或可达，也不表示每个 Service 支持全部采集命令。
本机其它已安装但未激活的版本不进入此列表。安装与卸载仍使用 `doctor plugin install/uninstall`。

| 命令 | 用途 |
|---|---|
| `doctor plugin` | 展示当前生效的 Plugin 与 Service 声明；`--format json` 供脚本消费 |
| `doctor chat` | 进入交互式 AI 问诊 |
| `doctor cpu` | 对目标 Pod 做 Python CPU、卡顿与线程栈取证 |
| `doctor mem` | 使用 fork-pyheap attach 并回传对象堆；余量不足时按安全进程拓扑准备 Headroom |
| `doctor mema [inputs...]` | 在 Doctor Host 用独立 Go analyzer 解析、缓存并诊断 `.pyheap` artifact |
| `doctor image` | 将当前目录的 image tar 按需准备到 Target Registry、Doctor Host 或两处 |
| `doctor debug` | 为目标 Pod 启动或复用 ptrace 临时容器；debug image 不可用时复用业务镜像 |
| `doctor install` | 交互选择并向目标 Pod container 安装 GDB，在线源失败时尝试 Doctor 离线包 |
| `doctor collect [id...]` | 集合选择并汇总 Data、Trace、Log、Metric；自身不实现具体采集 |
| `doctor trace` | 从 OpenSearch 下载 trace 并生成逻辑节点树 / 火焰图 HTML；bundle 模式保留原始 span |
| `doctor store` | 从 Service Pod 获取凭据，一次选择一个或多个 DB、VDB、S3、Redis 诊断；S3 同时统计前缀和对象年龄 |
| `doctor log [id...]` | 通过 Plugin traceId capability 解析 trace ID，再按业务 ID 分组聚合服务日志 |
| `doctor data [id...]` | 先扩展业务 ID，再按输入 ID 独立汇集各服务声明的数据 |
| `doctor inspect` | 检查 Service 的 workload 与配置，包括 Pod 重启/OOM、Toolchain、应用依赖和配置对照 |
| `doctor http` | 从 YAML 重放一个或多个 HTTP 请求，多轮采集并分析响应 |
| `doctor model` | 从模型目录选择目标，执行 validation/inference，并可选进行流式性能采样 |
| `doctor metric` | 使用 profile 中的 Prometheus，或临时抓取 Service `/metrics`，执行业务 detector 并生成离线 HTML 图表 |
| `doctor net` | 协调多个 Service Pod 短时抓包；选择 YAML 跟踪已知请求，或守候页面操作产生的请求 |
| `doctor neta [input]` | 纯离线分析 NetBundle，生成业务调用 Diagnosis 的 Markdown、泳道/瀑布 HTML 与结构化 JSON |
| `doctor version` | 显示 Doctor、当前平台及嵌入 Plugin 的精确版本 |
| `doctor help` | 显示命令帮助 |

`trace`、`log`、`data` 的业务 ID 既可直接写成 positional（如 `doctor trace <id>`），也可重复传入
`--biz-id`（如 `--biz-id=1 --biz-id=2`）。批量 HTML 按原始 ID 分 tab；每个 ID 的证据、Finding 和
Coverage 独立，只有采集批次和交付页面共享。

## 详细文档

- [CLI Kernel 与 Collect 共享协议](docs/kernel.md)
- [Collect 集合采集](docs/commands/collect.md)
- [Service Inspect](docs/commands/inspect.md)
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
