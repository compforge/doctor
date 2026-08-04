# doctor mem 内存泄漏演示

`leaky_app.py` 每秒保留约 2 MiB 的 `LeakyPayload`，并每 5 秒把最近两次 GC 类型计数原子写入
`/tmp/doctor-python-heap.json`。这是协作式取证：doctor 不会用 ptrace/gdb 注入任意 Python 进程。
没有协作快照时，doctor 还会自动解析已经存在的 `/tmp/memdump-<pid>-*.txt`，但不会为了生成新 dump
而给目标进程发信号；主动取证应留给未来独立的有副作用操作入口。

```bash
kubectl --kubeconfig ~/.kube/demo -n default apply -k cli/examples/memory-leak
kubectl --kubeconfig ~/.kube/demo -n default rollout status deployment/doctor-memory-leak-demo

doctor mem -n default --pod doctor-memory-leak-demo --interval 10

kubectl --kubeconfig ~/.kube/demo -n default delete -k cli/examples/memory-leak
```

预期 Findings 包含短窗口 RSS 增长，以及 `__main__.LeakyPayload` 对象数持续增长。该 Pod 会持续吃内存，
验证完成后应立即删除。
