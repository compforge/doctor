# Memory 诊断

## 理念 / 概念

Doctor 的 Python 内存诊断以 Pydump artifact 为中心，只保留两个命令：

- `doctor mem` 负责在线采集：attach 一个 Python 进程、生成 `.pyheap`、校验并回传本机。
- `doctor mema` 负责离线分析：在 Doctor 本机把 `.pyheap` 解析为
  `pydump.analysis/v1` JSON，再运行 detector 和报告；已有匹配 JSON 时直接复用。

旧的短窗口采样和三档 mode 已经删除。读取 Kubernetes、cgroup 与 `/proc` 的低成本事实会随
capture 顺手保存，但它们不是一条可以独立宣称诊断成功的路线；没有对象堆时，Doctor 不会用
这些有限事实替代 Pydump 结论。

Pydump 会通过静态 ptrace Injector 把有界 C Agent 加载到目标解释器，由执行容器内的 Collector
保留随堆规模增长的队列、索引和输出文件。Agent 持有 GIL 期间 Python 业务仍会暂停，
大堆可能持续数分钟，期间请求可能超时，异常中断也可能影响进程稳定性。因此
`doctor mem` 在真正 attach 前展示目标、执行位置、暂停影响、Uvicorn 保护和回传行为，并要求
用户确认；非交互调用必须显式传 `-y`。

## 流程

### `doctor mem`

```text
选择 Pod / container / Python PID
  ↓
探测已有 doctor debug container
  ├─ 可用：在 debug container 内运行 Pydump Collector
  └─ 不可用：检查目标 container 是否已具备完整 attach 前置
                 ↓
              按目标平台和 CPython minor 从 Doctor Toolkit 临时上传 Collector、Injector 与 Agent
  ↓
展示影响并取得确认
  ↓
必要时暂停 Uvicorn master（watchdog 兜底恢复）
  ↓
Injector attach/load/detach → Agent 持有 GIL 并流式生成 .pyheap → 恢复 master
  ↓
压缩、分片回传、双端 SHA-256 校验、原子落盘
  ↓
写入同 basename 的 .json 采集索引，并提示 doctor mema
```

默认输出：

```text
doctor-mem-<pod>-pid<pid>-YYYYMMDD-HHmmss.pyheap
doctor-mem-<pod>-pid<pid>-YYYYMMDD-HHmmss.json
```

采集索引使用 `doctor.memory-capture/v1`，记录目标 Pod/container/PID、镜像与重启次数、
采集策略、heap 大小和 SHA-256，以及顺手取得的进程扫描、cgroup、目标 libc、实际选择的
Pydump Agent 和 `/proc/<pid>/status` 事实。sidecar 中 heap 路径使用相对路径，便于两个文件一起移动。

### 两条 attach 路径

`auto` 默认先尝试已有且兼容的 doctor debug container。该容器必须正在运行，并同时具备：

- Python 3；
- Pydump Collector、匹配执行架构的 Injector，以及匹配目标 CPython minor、架构与最低 glibc
  兼容版本的 Agent（缺少时可从 Toolkit 上传）；
- 可写的 `/tmp/doctor-pydump`；
- 对目标 PID 实际可用的 ptrace 条件。

没有可用 debug container 时，Doctor 才检查目标业务容器。目标容器必须已经具备 Python 3、
可写临时目录和 ptrace；Python 环境本身不够。全部前置满足后，Doctor 按实际执行
Container 的 OS/架构与目标 CPython 3.10–3.14 minor 选择 Collector。Doctor 还会在目标业务
container 内使用目标 PID 对应的 Python executable 探测实际 libc：当前只接受 glibc，并从 Toolkit
选择最低 glibc 要求不高于目标版本的最新 Agent；musl、版本未知或低于全部已打包最低版本时在 ptrace 前
停止。当前 Agent 的最低兼容版本是 glibc 2.17，可运行于 glibc 2.17 及以上环境。匹配完成后，缺少的工具临时上传到
`/tmp/doctor-pydump` 再 attach。GDB 是 PyHeap 等其它采集路线的可选组件，不是 Pydump 前置。

如果两条路线都不满足，Doctor 列出每条路线的具体缺项并停止，不创建 debug container、不复制
对应工具、不退回短窗口采样。需要补齐 debug environment 时由用户另行执行 `doctor debug`。

可用 `--capture-via debug-container` 或 `--capture-via target-container` 强制指定路径；
指定路径不满足前置时直接失败，不跨路径兜底。

### Uvicorn 保护

procscan 通过 Python executable、父子关系和启动参数区分单进程与多进程 Uvicorn，不依赖可能被
setproctitle 改写的进程名。多进程模式下，dump 前先暂停 supervisor，避免它因 worker 暂时无法回应
内部健康检查而替换目标。Agent dump 结束后先给 worker 留出恢复时间，再恢复 supervisor；独立 watchdog
会在 Doctor 或 kubectl 意外中断后兜底恢复同一生命周期的 supervisor。

Doctor 仍在 dump 前记录 cgroup v1/v2 内存 limit 与用量，但不根据余量做启发式“内存不足”警告。
dump 失败后 Doctor 会再次读取 OOM 计数，只有 `oom_kill` 相比 dump 前增长时才把
本次失败归因为 cgroup OOM；supervisor 的暂停、恢复与两次 cgroup 事实都会写入 evidence。

单进程模式没有独立 supervisor 或兄弟 worker，attach 会同时暂停业务请求与该进程承载的 HTTP
liveness。Service 可通过 Plugin liveness capability 显式声明 `/health` 契约，并选择是否允许 heap dump
期间的临时响应。Doctor 只有在 Pod 实际 HTTP probe 与声明完全一致、Pod 不使用 hostNetwork，且已有
debug container 显式具备 `NET_ADMIN` 时才接管：仅匹配该 path 与 kube-probe User-Agent 的请求返回
Plugin 声明的成功响应，普通请求继续转发给业务端口。Doctor mem 不负责授予该 capability；现场已有则
直接使用，未授予时提示并自动降级，不尝试伪装 health。dump 结束后立即撤销网络规则；独立 watchdog
在 Doctor 意外退出时按超时兜底清理。

该能力不隐式扩大 debug 权限。默认 debug container 不申请 `NET_ADMIN`；需要代理时由用户交互选择
“memory+liveness”，或执行 `doctor debug --capabilities SYS_PTRACE,NET_ADMIN`。HTTPS、hostNetwork、
自定义空 User-Agent、运行态 probe 与 Plugin 声明不一致等场景保持原有警告，不伪装健康。

### Artifact 交付

远端 heap 先压缩，再通过多个有界分片回传。每片失败可从同一 offset 重试；本机先写临时文件，
压缩文件与解压后的 heap 都通过容器端元数据校验，成功后才原子改名。失败时不交付半份本地
heap，并告诉用户远端文件位置。

远端 `/tmp/doctor-pydump` 默认保留，便于回传失败后人工恢复；显式传
`--cleanup-remote` 才会在本地交付成功后删除。

### `doctor mema`

`doctor mema [inputs...]` 完全在 Doctor Host 运行，不连接 Kubernetes。输入支持：

- 一个或多个 `.pyheap`；
- `doctor.memory-capture/v1` sidecar；
- 已解析的 `pydump.analysis/v1` JSON。

输入 `.pyheap` 时，分析 JSON 使用同 basename 的 `.pydump-analysis.json`。Doctor 先核对 JSON
中的 source size 和 SHA-256；匹配则复用，不匹配或损坏才重新运行 Toolkit analyzer。Doctor 优先探测
本地 Docker、Podman 或 nerdctl 中已经 load 且携带兼容 analyzer 的 doctor-debug image；没有可用
container backend 时才回退 Toolkit 中与 Host OS/架构匹配的独立 Go analyzer。探测不会隐式
load image。container 分析关闭网络，
并只读挂载 heap 文件。retained-heap 可能显著消耗 Doctor Host 内存，因此不再支持 Pod 内分析。

未给输入时，Doctor 扫描当前目录：优先跟踪 `doctor.memory-capture/v1` 采集索引；没有索引时
才使用分析 JSON，最后兼容裸 `.pyheap`。这样一次采集只有一个默认入口，不会因派生产物重复发现。

多个 heap 会按 dump 时间排序，报告除逐份 detector 结论外，还给出首次到末次的 type 级对象数
与 shallow size 变化。对象地址跨进程和时点不稳定，因此 retained owner 地址不直接做差。单次
或多次存量快照都不能单独证明泄漏；确认持续泄漏仍需要结合时间趋势、请求负载和分配历史。

## 关键设计

### Capture 与 analysis 生命周期分离

在线 attach 的首要目标是尽快恢复业务进程并可靠交付原始 artifact；retained-heap 分析可能非常
吃内存，放在 Pod 内会与业务争抢资源。两者拆开后，同一 heap 可以在更合适的机器上重复分析，
分析规则升级也不需要重新触碰客户进程。

### 不把工具存在等同于 attach 可用

Injector 可执行文件存在不代表容器运行态允许 attach；容器声明 `SYS_PTRACE` 同样不代表运行态
attach 一定可行。Doctor 在上传和确认前分别验证 Python、临时目录与实际 ptrace 条件，任一缺失都停止。

### 原始 heap 是事实来源

analysis JSON 和 HTML 都是可重建派生物；`.pyheap` 才是对象图的稳定事实来源。缓存命中绑定
heap 大小与 SHA-256，避免同 basename 被替换后误用旧结论。

### 目标端与 Doctor Host 能力分开

`doctor mem` 所需 Python、Injector 和 ptrace 属于诊断目标；`doctor mema` 所需 Go analyzer 或本地
container engine 属于 Doctor Host。两边独立探测、独立报错，不能把“目标容器有 Python”
误当成本机能够分析。通用 Host/Target 能力边界见 `kernel.md`。
