# Doctor 发行版

## 理念与边界

Doctor 是上游通用诊断 CLI。发行版复用同一套 Command、环境访问与 Evidence 生命周期，面向某类使用者
选择入口名称、发行版本、说明、命令展示和内置 Plugin，不复制 Core，也不建立另一套命令执行流程。

- **Core** 拥有命令与执行契约、通用连接参数、Help 生成和版本报告。
- **Distribution** 拥有用户看到的 CLI 身份及命令展示策略，由发行方的 composition entry 固定。
- **Plugin** 拥有 Service、业务能力和 Skills。Plugin 的身份与版本不因发行版名称改变。

Plugin 与发行版是两个独立维度：同一 Plugin 可以被不同发行版内置，发行版也可以不内置 Plugin，
继续使用 Doctor 的 Host Plugin 加载机制。没有发行配置时，名称为 `doctor`，版本沿用 Doctor Core，保留通用描述。

## 装配流程

发行方通过 `doctor-cli/embed` 的公共入口传入包含可选 Plugin 的 `Distribution`：

```ts
import { startDoctor, type Distribution } from "doctor-cli/embed";
import plugin from "./plugin";

const distribution = {
  name: "samplectl",
  version: "2.3.4",
  description: "Sample application diagnostics powered by Doctor",
  plugin,
  optionDefaults: { config: "", yes: true },
  commandDefaults: {
    inspect: { format: "manifest" },
    log: { format: "manifest", since: "30m" },
  },
} satisfies Distribution;

startDoctor(distribution);
```

使用 Doctor 的构建入口编译这份 entry；产物文件名由发行方选择，与 Help 名称显式保持一致：

```bash
make -C cli build-mac DOCTOR_ENTRY=/path/to/entry.ts DOCTOR_COMMANDS=inspect,data,plugin
```

`name` 作用于根命令与嵌套子命令的 Usage，`description` 替换根命令说明。`commands` 可在发行配置中
显式指定逗号分隔的命令列表；未指定时使用构建期 `DOCTOR_COMMANDS`，后者默认 `all`。希望按次构建调整
命令列表的发行方应省略 `commands`，只传名称与描述。`help/version` 始终可见。

## 关键设计

### 命令默认值属于发行体验

`optionDefaults` 设置根参数默认值，`commandDefaults` 设置各命令自己的参数默认值；
二者共用参数声明与校验。发行默认值不是权限限制，显式参数仍可覆盖。

`optionDefaults.yes = true` 使发行版默认启用 `-y/--yes`：整个调用树不询问，
使用显式参数、已有配置和已声明默认值；必要信息仍无法确定时以参数错误退出，不能猜选目标。
`-y` 预先批准已选操作，不自动开启可选采集；例如 inspect 的配置与依赖采集仍需
`--deployment-config` / `--dependencies`。显式 `--no-yes` 可恢复 Doctor 原有的交互终端体验。

`optionDefaults.config = ""` 让发行版默认不读取 Doctor 配置，包括 `DOCTOR_CONFIG` 指向的文件。
普通 Doctor 未设置此默认值，仍按 `--config`、`DOCTOR_CONFIG`、`~/.doctor/config.yaml`
解析配置入口。显式非空 `--config` 可以重新启用配置；空字符串不能被当作未指定。
Help 根据有效入口隐藏 profile 相关选项和 `init/profile` 命令，直接调用依赖配置的入口会报错。
这不限制显式 kubeconfig、SQL 文件或离线证据的读取。

`commandDefaults` 按 Command 名和参数的 camelCase 名配置默认值，只能引用命令已经声明的参数。
参数解析与可选值检查复用 CLI 声明，Help 显示发行版实际默认值；显式 CLI 参数和 Commander 的环境变量
绑定优先。未配置的命令继续沿用 Core 默认行为，不修改共享 Command 的运行逻辑或子命令交付流程。

例如 `log.format = "manifest"` 让 `samplectl log` 默认交付机器可读索引，
`samplectl log --format html` 仍显式选择 HTML。`manifest` 的证据目录与输出契约见
[机器可读取证交付](manifest.md)。

### 展示不是权限边界

命令列表复用 Commander 的 `hidden`：隐藏命令仍可直接执行，代码与依赖不保证被移除。
发行版不改变 Plugin capability 检查、风险授权或组合命令内部能力。显式配置无效命令名会报错。

### 目标配置归宿主

`--config`、`--namespace/-n`、`--kubeconfig` 与 `--context` 在根命令统一声明，子命令通过 Commander 的全局选项合并取得它们，
再进入现有 CommandContext；不放进 Plugin config，不修改进程级环境变量或 kubeconfig 当前 context。
Help、Plugin 信息与版本展示保持离线，不因传入目标参数而连接 Kubernetes。
namespace 的默认值仍为 `default`；解析器提供的默认值不覆盖 profile 中的 namespace。
配置关闭时不选择 profile，只使用显式参数和运行默认值。

### 发行版本与内嵌组件版本独立

`Distribution.version` 是面向用户的发行版本，未指定时使用 Doctor Core 版本；名称与版本可独立设置。
发行方从自己的发布元数据注入版本，不修改内嵌 Core 或 Plugin 的版本事实源。

- `--version/-V` 只输出发行名称与版本，不加载 Plugin 或准备诊断目标。
- `version` 先输出发行身份，再报告 Doctor Core、当前 Plugin 和本机信息；发行身份与 Core 相同时不重复输出。
- 两种入口都只读本地信息，不加载诊断 profile、不探测 Kubernetes；目标运行状态由诊断命令采集。

这样用户可确认安装的发行包，排障时也能追溯实际内嵌组件；Plugin 版本不能代替发行版本。

### 运行时是构建选择

`BUNDLE_RUNTIME=true` 交付自包含可执行文件，沿用各平台的 Bun executable / Node SEA 构建；
`false` 只打包应用代码和依赖，交付启动脚本及同目录 `.mjs`，使用客户已有的 Node >= 22.23.1。
这一选择与 Plugin 无关，也不影响 `Distribution` 的运行时装配契约。发行方可以在自己的构建清单中
设置默认值，并允许每次构建覆盖；无需把是否内嵌 Node 写入业务 Plugin。
