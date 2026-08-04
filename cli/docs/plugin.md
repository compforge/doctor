# Plugin 分发

> 协议包与源码目录边界已落地，归档安装和 profile 加载尚未实现。本文定义 doctor CLI 的本地 Plugin
> 分发边界；首版面向 ToB 离线交付，不引入 Marketplace、独立 Runner 或热加载。

## 理念 / 概念

doctor core 后续需要开源，但具体产品的 Service Catalog、固定查询和排障知识可能属于企业内部资产。
Plugin 用一个版本化归档把这些产品扩展从 core 中分离，并允许同一份交付物同时贡献：

- **PluginDefinition**：向确定性诊断提供 Service Catalog 和插件级 capability；
- **Skill**：采用标准 `SKILL.md` 目录，供本地 `doctor chat` 的 agent loop 渐进加载业务知识和脚本。

一个 Plugin 只导出一个 `PluginDefinition`，不再增加 Product 中间层。Service Catalog 仍是 capability
的事实来源；Plugin manifest 只定位代码和 Skill，不重复声明 store、log、data、model 等能力。

monorepo 中的源码按依赖方向分为三层：

```text
cli/src/plugin/              Plugin 安装、选择与加载的宿主边界
packages/plugin/             doctor-plugin 协议与可选共享 SDK
plugins/<plugin>/            可独立构建、归档和分发的具体 Plugin 实现
```

领域依赖保持 `cli/collect -> packages/plugin <- plugins/<plugin>`。CLI core 只接收注入的
`PluginDefinition`，不引用具体 Plugin；根目录发行构建和后续 profile loader 分别负责在编译期、运行期
取得具体实现，collect 不感知来源。

Doctor 与 Plugin 的运行边界只约定三件事：Plugin 声明自己能提供哪些 capability；Doctor 在每次调用时
告知当前 profile 选择的 Kubernetes 环境和 Service；Plugin 返回对应 capability 约定的结果，使 Doctor
能够统一串联、诊断和展示。Plugin 如何访问 Service、HTTP 或数据库属于其自身实现，不进入能力协议。

首版只保留两个持久事实：

1. Doctor Host 已安装哪些 `plugin@version`；
2. 每个 profile 选择哪个精确插件版本。

profile 就是激活边界。运行态 capability 和 Skills 都从当前 profile 推导，不增加 Package / Instance /
Binding、全局 current 软链或常驻插件进程。

```text
Plugin archive ──load──> ~/.doctor/plugins/<plugin>/<version>/
                                      │
Profile ──select exact versions───────┘
   ├── PluginDefinition ──> ServiceCatalog ──> collect
   └── Skills ─────────────────────────────────> local doctor chat
```

一个 profile 选择一个业务 Plugin；切换 profile 即切换 Plugin。一个 Plugin 可同时携带多个 Skill，
不为多个业务 Plugin 的并行组合设计额外生命周期。

## 流程

### 归档与安装目录

首版接受 tar/tar.gz；后续增加其它归档或下载来源时，仍落到同一安装目录：

```text
~/.doctor/plugins/
└── sample/
    └── 1.2.0/
        ├── plugin.json
        ├── plugin.mjs
        └── skills/
            ├── service-ops/
            │   └── SKILL.md
            └── trace-ops/
                └── SKILL.md
```

归档文件名不参与身份判断，真实 `id` 和 `version` 只取自根目录的 `plugin.json`。manifest 的最小形态：

```json
{
  "manifestVersion": 1,
  "id": "sample",
  "version": "1.2.0",
  "requiresDoctor": ">=0.1.0",
  "main": "./plugin.mjs",
  "skills": ["./skills/service-ops", "./skills/trace-ops"]
}
```

Plugin 入口是可直接执行的 Node-compatible ESM，默认导出一个 `PluginDefinition`。manifest id 与导出
对象 id 必须一致。归档必须自包含运行依赖，不在客户现场执行 `npm install`、
install script 或编译 TypeScript；Skill 目录可携带其 `references/`、`scripts/` 等标准资源。

### `doctor plugin load`

```bash
doctor plugin load ./sample-1.2.0.tar.gz
doctor plugin load ./sample-1.2.0.tar.gz --profile sample
```

`load` 是面向用户的一步式“安装并选择”操作：

1. 在临时目录解包，读取并校验 manifest、Doctor 版本兼容性和所有资源路径；
2. 加载代码入口并校验其满足 `PluginDefinition`，扫描 Skill 的基础元数据；
3. 原子移动到 `~/.doctor/plugins/<id>/<version>/`；目标版本已存在时不原地覆盖；
4. 指定 `--profile` 时，在安装完全成功后把精确 `id@version` 写入该 profile；未指定时选择当前
   profile；
5. profile 已选择同一 Plugin 的旧版本时替换该引用，但保留旧版本目录。

安装目录中的版本内容不可变。失败发生在 profile 更新前，不改变当前可用版本；旧版本的清理由显式
remove/GC 能力负责，不隐含在 load 中。

profile 中的选择关系示意如下：

```yaml
profiles:
  sample:
    plugin: sample@1.2.0
```

### 命令运行

CLI composition root 解析 profile 后加载其精确 Plugin 版本：

1. 校验引用的版本仍存在，并加载 Plugin 代码与 Skill；
2. Skill name 冲突时直接报错，不按加载顺序静默覆盖；
3. 需要业务语义的 collect 命令取得 profile 选择的 `PluginDefinition`，继续走现有通用 collect 链路；
4. 不依赖业务 Plugin 的离线命令保持零配置可用；
5. 本地 `doctor chat` 合并 profile Plugin Skills 与用户级 `~/.doctor/skills`，按现有 Skill 协议渐进加载。

Plugin 是 Doctor Host 的本地状态。CLI 不向远端执行环境隐式上传本地 Skill 或 Plugin；若后续需要
会话级上传，应作为独立协议和授权能力设计，不能隐含在 Plugin load 中。

### 升级与回退

升级不需要独立状态机：load 新版本成功后，将 profile 的精确版本引用从旧版切到新版。旧版本仍在时，
把 profile 引用切回即可回退。进程启动后不监听目录变化；正在运行的命令或 chat 继续使用启动时解析的
版本，新版本在下一次进程启动时生效。

## 关键设计

### Profile 取代独立激活生命周期

Doctor 的 ToB 使用方式以一套现场配置对应一个业务 Plugin 为主。profile 已经拥有环境、凭据和能力
选择，继续由它选择 Plugin/Skills 能避免再维护 Instance、Binding
及二者与 profile 的同步关系。

### 确定性能力与 Skill 是独立贡献

`PluginDefinition` 是确定性诊断的代码和 capability，Skill 是 agent 使用的知识与工作流。两者可在
同一 Plugin 中一致交付；安装版本一致不意味着运行接口或生命周期需要合并。

### 协议负责能力对接，SDK 负责代码复用

`doctor-plugin` 同时承担稳定协议和可选 SDK，但两者职责不同。协议定义 Plugin/Service/capability 的
声明、调用输入输出，以及所有 Service 共用的 `PluginContext`；上下文提供当前 kubeconfig、context、namespace、
当前 Service 和取消信号等已确定的运行态事实，不为不同 Service 固化不同访问接口。profile 切换后，
Doctor 在下一次调用中注入新的上下文，Plugin 不持有旧环境选择。

port-forward 的本地端口分配、取消和回收具有明确的 Doctor 调用生命周期，因此由 `PluginContext` 按需
提供。HTTP、数据库和 Kubernetes 访问由 Plugin 自行实现；以后只有出现稳定的跨 Plugin 重复时，才把
helper 提取到 SDK。协议不注入 Doctor 的 `HttpTransport`、`Database` 等具体实现。Service 定位规则、
API、SQL、表结构及诊断知识始终属于具体 Plugin。

### 分发机制不进入业务层

解包、路径校验、版本目录和 profile 更新属于 `cli/src/plugin` 宿主边界；`packages/plugin` 只定义
Plugin 与 Service 公共语义，collect 只消费注入的 `PluginDefinition`，本地 agent loop 只消费解析后的
Skill roots。这样将来由本地 tar
扩展到私有下载源时，不会改变 Catalog 或诊断领域实现。

### 归档是受信任代码，但仍需安全解包

Plugin 与 Doctor CLI 同进程运行，拥有相同的文件、网络和凭据权限；首版不承诺安全沙箱，只允许加载
来自受信任交付渠道的 Plugin。解包仍必须拒绝绝对路径、`..` 穿越、符号链接逃逸和越出插件根目录的
manifest 入口，并使用临时目录加原子 rename，避免半安装状态。签名和私有仓库可以后续增加，不改变
本地安装模型。

### 首版明确不做

- Marketplace、在线搜索或自动升级；
- Package / Instance / Binding、独立 Runner 或插件间依赖解析；
- 同版本原地覆盖、运行中热更新或动态卸载；
- 客户现场依赖安装和 install script；
- CLI 到远端执行环境的隐式 Skill/Plugin 上传。

### 同一实现支持 tar 与定制 binary

企业 Plugin 的 workspace `package.json` 可只服务开发和构建，保持 `private: true`，不发布 npm。
标准交付把自包含 `plugin.mjs` 与 Skills 打成 tar，由通用 Doctor binary 手动加载；需要定制 binary 时，
分发方可提供独立 composition entry 并复用 `cli/Makefile`。本仓根 `make build/install` 始终构建不带具体
Plugin 的通用 CLI。两种形态共用 `PluginDefinition` 与 capability，差别只在启动时如何取得 Plugin。
