# Compute 资源概览

`doctor compute` 分别展示 Kubernetes 集群资源和业务 Service 的 Workload 占用。
Core 复用 Quality Harness Toolbox 的采集与计量，Plugin 只需已有的 `Service.workloads` 声明，
无需新增 Extension。没有 Plugin 时仍可查看集群。

```bash
doctor compute --profile test
doctor compute --profile test -s api -s worker
doctor compute --context customer -n app -f summary
doctor compute --max-pods 2000 --max-nodes 500 --timeout 60
```

未指定 Service 时展示全部已加载的 Service；显式 Service 名称通过 Catalog 解析别名并去重，
未知名称在访问 Kubernetes 前报错。未声明 Workload 的 Service 显示未声明，不视为零占用。
namespace 复用全局参数和 profile；Workload 显式声明 namespace 时按其声明读取，报告保留实际作用域。
集群视图始终读取 cluster 范围，不将 namespace 的数据充当完整集群。

## 两部分结果

1. 集群：Node capacity、allocatable、已调度 Pod requests、全部活动 Pod requests 和 Node Metrics 使用量；
   Node 明细保留 Ready、是否可调度、指标时间和采样窗口。
2. Service：已观测 Pod / Ready 数、requests、已声明 limits、实际 CPU / 内存，附 Workload 发现记录和 Pod 明细。

CPU 以 cores、内存以 GiB 展示；JSON 保留 Toolbox 的 cores / bytes 数值。
requests 为 Pod spec 的有效需求，包括 init/sidecar 峰值、Pod 级资源与 overhead；不代表实时 cgroup 分配。
limits 仅表示已声明值，同时显示未声明 limit 的容器数，不将缺失 limit 解释为资源上限零。
实际 CPU/内存来自 Metrics API，分别是采样窗口核数和 working set。
Failed/Succeeded Pod 保留在盘点中，但不计入活动资源汇总。

同一 Service 内按 namespace / Pod UID 去重，始终统计整个 Pod；Workload 的 container 默认值不会缩小统计范围。
不同 Service 可以共享 Pod，因此 Service 汇总不可相加作为集群总量。allocatable 也不等于可调度剩余量。

## 权限、覆盖与预算

客户 context 缺少 Nodes、全 namespace Pods 或 Metrics 权限是正常情况。统一 Toolbox 错误
`permission_denied` 在对应范围显示“无权限”，不做健康判断，也不阻断后续 namespace / Service 采集。
仅权限限制不令命令失败；超时、截断或其它采集错误保留 partial 完成状态。

发现失败、没有实例、没有指标和真实零用量分开表示。发现覆盖与 Pod 采集覆盖独立保存；
后续 Pod 读取成功不能抹掉发现阶段的权限或分页缺口。部分汇总只描述已取得的数据，不能作为完整总量。

`--timeout` 默认 30 秒，分别约束集群采集和每个 Service 的发现加采集；
`--max-pods` 默认 1000，限制集群 Pod 采集、每个 Workload 的发现及每个 Service 的 Pod 采集；
`--max-nodes` 默认 500，分页大小为 200。访问复用命令持有的 Kubernetes Client，单响应仍受共享字节上限约束。
不安装 metrics-server、不执行 Pod 命令，也不修改任何 Kubernetes 对象。

Ctrl+C 通过 CommandContext 的共享信号停止后续访问，保留已经写入的快照。执行期间打印当前集群 / Service 阶段。
终端显示两部分汇总及覆盖问题，Node / Pod 明细保留在 HTML 和 JSON 中。
默认输出终端概览及 HTML + Bundle；`-f summary` 仅显示摘要并保留临时证据，`-f manifest` 输出证据目录。
序列化与 HTML 渲染只消费本地证据，不重新访问 Kubernetes。
