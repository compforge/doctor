# Memory 诊断

## 理念 / 概念

Doctor 的 Python 内存诊断以语言中立的 `.pyheap` artifact 为中心：

- `doctor mem` 在线采集对象堆，固定使用 Doctor 维护的 fork-pyheap。
- `doctor mema` 在 Doctor Host 离线分析 `.pyheap`，生成 detector 结论和报告。

fork-pyheap 由 GDB 在目标解释器中遍历对象。它的索引、临时引用和 heap 写入会增加目标 Python
进程及其 cgroup 的内存压力，而现场通常正是在内存接近 limit 时才需要 dump。Doctor 因此在 attach
前探测 cgroup 与进程拓扑，并在确有必要且可以安全恢复时通过 Headroom 为 dump 准备内存余量。

Headroom 是 dump 前后的通用编排，不属于 PyHeap backend。它只能采用 Doctor 已明确理解的进程模型，
不能根据进程名或 RSS 猜测性结束进程。当前支持 Uvicorn multiprocess：暂停 supervisor、保留目标
worker 和一个服务 worker、临时退出其余 sibling workers，dump 后恢复 supervisor 并确认 worker 数量补齐。

## 流程

### `doctor mem`

```text
选择 Pod / container / Python PID
  ↓
Inspect cgroup 与 process-topology Facts
  ↓
准备已有 debug container 或目标 container 中的 PyHeap attach 环境
  ↓
计算 Headroom
  ├─ cgroup 剩余内存 >= 目标 worker RSS × 2：跳过
  ├─ 余量不足且命中安全策略：展示临时缩容计划
  └─ 事实不足或拓扑不支持：跳过，不结束任何进程
  ↓
展示 attach、Headroom 和容量下降风险，取得用户确认
  ↓
必要时暂停 supervisor → 退出冗余 sibling workers → 复查 cgroup
  ↓
fork-pyheap attach 并流式生成 .pyheap
  ↓
恢复 supervisor，确认 worker 数量补齐
  ↓
压缩、分片回传、双端 SHA-256 校验、原子落盘
```

默认输出：

```text
doctor-mem-<pod>-pid<pid>-YYYYMMDD-HHmmss.pyheap
doctor-mem-<pod>-pid<pid>-YYYYMMDD-HHmmss.json
```

采集索引使用 `doctor.memory-capture/v1`，记录目标、PyHeap 版本、执行位置、heap 元数据，以及进程扫描、
cgroup、目标进程状态和 Headroom 前后的事实。原始 `.pyheap` 是事实来源；分析 JSON 和 HTML 均可重建。

### 执行位置

`--capture-via auto` 优先使用已有且兼容的 doctor debug container；没有时检查目标业务容器。执行环境
必须能进入目标 PID namespace、具备实际可用的 ptrace、Python 3、支持 Python scripting 和 inferior call
的 GDB，以及可写临时目录。fork-pyheap dumper 缺失时从 Toolkit 临时上传；GDB 缺失或不兼容时使用
带 GDB 的 debug image，或先执行 `doctor install gdb`。

可用 `--capture-via debug-container` 或 `--capture-via target-container` 强制指定执行位置。指定位置不满足
前置时直接失败，不创建 debug container、不安装系统包，也不退回其它采集器。

### Headroom

Headroom 仅在 cgroup limit、当前用量、目标 worker RSS 和受支持进程拓扑均可确认时启用。目标 cgroup
剩余内存达到目标 worker RSS 两倍时无需腾出进程内存。余量不足时，当前 Uvicorn 策略还要求：

- 目标 PID 是 multiprocess supervisor 的直属 worker；
- 至少存在两个 sibling workers，确保缩容后仍保留一个服务 worker；
- 所有计划中的 PID 在执行前仍属于同一生命周期的 supervisor。

Doctor 保留 RSS 最小的 sibling worker 服务请求，优先退出其余高 RSS sibling workers。退出先发送
`SIGTERM` 并等待有界宽限期，超时才发送 `SIGKILL`。supervisor 在缩容前暂停，避免立即补进程；独立
watchdog 在 Doctor 或 kubectl 意外中断时兜底恢复同一生命周期的 supervisor。dump 完成后 supervisor
恢复并补齐原 worker 数量，Doctor 对恢复结果做有界验证。

Headroom 会降低服务并发容量，退出 worker 上的在途请求也可能失败，所以计划必须在 attach 前随风险
一起展示并取得确认。单进程、双 worker、未知 supervisor、事实不完整以及其它尚未支持的进程模型均跳过。

### Artifact 交付

远端 heap 先压缩，再通过有界分片回传；每片可从同一 offset 重试。本机先写临时文件，压缩文件与
解压后的 heap 都通过容器端元数据校验，成功后才原子改名。失败时不交付半份本地 heap，并报告远端
文件位置。远端 `/tmp/doctor-pyheap` 默认保留；显式传 `--cleanup-remote` 才在本地交付成功后删除。

### `doctor mema`

`doctor mema [inputs...]` 完全在 Doctor Host 运行，不连接 Kubernetes。它接受 `.pyheap`、
`doctor.memory-capture/v1` sidecar 或已解析的 `pydump.analysis/v1` JSON。分析协议是语言中立的独立契约，
不代表在线采集使用 Pydump。

Doctor 优先复用与 heap 大小和 SHA-256 匹配的分析 JSON；否则运行 Toolkit analyzer。它先探测已加载且
带兼容 analyzer 的 doctor-debug image，没有可用 container backend 时才回退到 Host 平台对应的独立
analyzer。retained-heap 分析只在 Doctor Host 进行，避免再次占用目标 Pod 内存。

## 关键设计

### 进程拓扑是运行态 Fact

进程布局由 Core 从目标容器 `/proc` 观察，不由 Plugin Service 声明。Plugin 不可能可靠知道某次运行的
PID、worker 数、父子关系和生命周期；Headroom planner 只消费本次 Inspect 得到的事实。

### dump 原语与 Headroom 编排分离

`infra/dump` 拥有 PyHeap 的环境探测、工具准备、dump command、失败解释和文件操作。`collect/memory`
拥有 PID 选择、Headroom、风险确认、supervisor guard、Evidence 和 artifact 交付。进程模型不会渗入
dump backend，新的 Headroom 策略也不需要修改 PyHeap。

### 不伪装 liveness

Doctor 不修改 Pod 网络规则，也不申请 `NET_ADMIN` 来代答健康检查。多 worker 场景通过保留一个服务
worker 降低 liveness 中断风险；单进程场景明确提示 attach 会暂停业务与健康检查，由用户决定是否继续。

### 失败归因基于事实变化

dump 失败后 Doctor 再次读取 cgroup OOM 计数，只有 `oom_kill` 相比 dump 前增长时才归因为 cgroup OOM。
supervisor 暂停恢复、Headroom 计划与执行、Headroom 后 cgroup 事实和最终恢复验证都进入 Evidence。
