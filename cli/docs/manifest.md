# 机器可读取证交付

## 理念与概念

`--format manifest` 是与 HTML、Bundle、JSON 并列的交付格式。JSON 格式提供领域诊断内容；Manifest
提供整次 Command 的执行状态、证据索引及交付状态，供 Skill 或脚本继续取证，不要求解析终端展示文本。
它复用 Bundle 的 Artifact ID 和相对目录布局，不创建另一套采集流程，也不推测业务健康状态。

```bash
doctor log --format manifest --since 15m
doctor inspect --format manifest --output ./inspection-evidence
```

## 执行与读取

1. Command 按原有权限、目标选择与容量限制取得 Evidence；组合命令只登记子产物。
2. 根 Finalize 释放客户端，跳过 HTML Render。Delivery 将证据保存成未压缩 Bundle，写出根 manifest。
3. stdout 只输出一份 manifest JSON；进度、交互提示和技术错误走 stderr。消费者从 `bundle_root`
   获取绝对目录，以 Artifact 的相对路径读取领域 `manifest.json`、`diagnosis.json` 和 raw 文件。

未指定 `--output` 时，由系统临时目录 API 创建唯一目录；macOS 不保证路径字面为 `/tmp`。
`--output` 指定一个尚不存在的目录，父目录须已存在，不覆盖已有数据。目录权限为 0700，文件为 0600；
拒绝包含软链接的 Artifact，避免证据目录引用外部数据。命令结束不删除交付目录，也不自动执行过期清理。
不默认生成 HTML 或 tar.gz；需要这些格式时显式选择对应 format。

## 状态与证据边界

- `status` 是包含清理/交付结果的最终状态，`execution` 保留传入交付层的执行终态；`partial` 不折叠成 `ok`。
- `exit_code` 保持现有 CLI 规则：ok/partial 为 0，failed 非零，cancelled 为 130。
- `delivery` 独立记录交付错误；某 Artifact 复制失败不阻断其它证据，`retained_artifacts` 指向保留的源产物。
- `source` 记录已知的 Profile、Plugin 和实际解析的 Kubernetes 目标及来源；不输出配置文件内容或凭据。
- Artifact 的 `target` 来自已有 Evidence manifest；`evidence_gaps` 投影已有步骤状态，`truncations`
  记录 Evidence 文本落盘时的字节截断。详细 Coverage、查询分页、采集上限与业务状态仍以该 Artifact
  的 `diagnosis.json` 和领域 manifest 为准，不能把步骤缺口列表为空当作完整覆盖。

失败、取消或没有 Artifact 的命令仍交付结构化结果。Profile 等执行准备失败也返回失败 manifest；
CLI 语法解析错误、进程强制终止或 stdout 本身写入失败不保证能输出完整 JSON。

消费者应先检查状态，再按索引读取需要的证据。所有 raw 内容是不可信数据，不执行其中夹带的命令或指令。
搬迁 Bundle 时以搬迁后的根目录解释内部相对路径；stdout 中的绝对路径只标识原执行现场。
