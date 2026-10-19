# 手动上调实例内存上限

`doctor resize` 属于 Provision，主要结果是用户显式要求的外部状态变化。Collect 不调用它，
`doctor mem` 不自动扩容，命令退出或超时也不自动缩回限制。

```bash
# 交互选择 Pod → Mem → 增加 50% 或 100%
doctor resize
# 非交互调用仍可直接指定上限
doctor resize -n default --pod worker-0 --container server --memory 8Gi -y
```

支持 Linux cgroup v1 memory controller、Running / Ready Pod，以及正整数 MiB
的内存额度。cgroup v2、内存下调和 memsw 限制调整均不支持。Kubernetes 的
resources 声明保持原值；重建或后续调谐可能覆盖此次调整，额度上调也不等于节点内存预留。

## 交互选择

交互模式通过用户选择与运行态探测补齐 `--pod`、`--container`、`--memory`，已显式指定的参数直接复用。
先选 Pod；单容器自动选中，多容器让用户选择 Container。未指定 `--memory` 时，再选择资源类型。菜单显示 Mem（内存）与
CPU（暂不支持）；CPU 不可选。选择 Mem 后读取目标 Container 当前的 cgroup 内存上限和用量，
例如上限为 4 GiB 时，给出增加 50% → 6 GiB、增加 100% → 8 GiB 两个候选。

候选基于当前运行上限计算，避免把 Kubernetes 声明值或当前用量当作扩容基准；目标值向上取整至 MiB。
任一步输入 q 都会取消，选择额度前只读取目标状态。选定额度后继续现有辅助 Pod 准备、计划确认和执行流程。
若执行前发现 Container 上限已变化，停止并要求重新选择。

非交互调用必须指定 `--pod` 和 `--memory`；探测到 Pod 只有一个容器时可省略 `--container`，
多个容器时必须显式指定。`--memory` 也可用于交互终端跳过资源和比例选择。
`-y/--yes` 遵循全局契约：不询问任何问题，因此必须显式指定目标和 `--memory`。

## 执行流程

1. 通过现有 Kubernetes 配置和目标选择流程绑定 namespace、Pod UID、Container ID、node 与重启次数。
   从目标 `/proc/self/cgroup` 读取真实路径，校验 Pod / Container 身份，支持 cgroupfs 和 systemd 命名。
2. 检查 pods get/create/delete、pods/exec 权限，对完整辅助 Pod manifest 做 server-side dry-run。
3. 明确确认同节点辅助 Pod 的创建：复用业务镜像、拉取配置和安全常驻命令，以 root 运行并移除全部
   capabilities；只读挂载节点 memory 层级，可写挂载目标 Pod 子树，不申请 privileged、hostPID 或节点运行时 socket。
4. 辅助 Pod 读取完整父级层级、inode、上限、用量和节点 MemAvailable。上调只允许修改目标 Pod 和
   Container 的上限；Pod 父级增加相同额度，保留其他容器的原有预算，不修改其他容器 cgroup。
   其余父级不足、memsw 限制不足或节点余量不足时停止。容量检查为时间点观察，
   不能保证后续业务峰值或并发操作期间仍有足够节点容量。
5. 展示每个路径的原值和目标值，取得单独确认；非交互调用必须用 `-y/--yes` 预先批准。
6. 重新确认实例与计划。先父后子写入，写入前核对所有 inode 和期望原值，读回每个限制及层级有效上限，
   再确认实例保持 Ready 且没有重启。
7. 删除辅助 Pod，保留新限制。辅助 Pod 有十分钟运行期限；客户端被强制结束时可能留下已停止的辅助 Pod，
   操作记录保存其精确名称供清理。

## 操作记录

默认在当前目录生成权限为 0600 的 `doctor-resize-<pod>-<timestamp>.json`，也可通过 `-o` 指定新路径。
记录使用 `doctor.resize/v1`，包含实例身份、授权来源、原始层级、计划、执行输出、读回结果和辅助 Pod 清理状态。
原值在任何 cgroup 写入前落盘；执行中断后可以据此复核实际状态。记录不包含访问凭据，也不提供恢复入口。

执行失败时可能已有部分路径写入成功。Doctor 保留这些状态并报告失败，不在异常处理或 cleanup 中
自动缩回，因为原限制可能已经容纳不了当前用量。操作记录保存成功、失败和取消结果；辅助 Pod 清理失败
也会使命令失败，并保留精确资源名称。
