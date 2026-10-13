# doctor trace

`trace` 先采集并标准化 trace/span，再在同一份本地证据上选择 view 和 render format。
原始 spans、Node、Measurements、Findings、AgentRun 和 HTML 使用同一份采集结果。
业务语义和 AgentRun 提取由 Plugin 贡献，Core 不内置业务节点规则。

## 查看对象与格式

| 对象 | 参数 | 内容 |
|---|---|---|
| Trace | `--view default`（缺省） | 完整调用栈 |
| Trace | `--view agent` | Agent 视角调用栈，保留源 node/span 引用 |
| Node | `--node <id> --view default` | 节点事实、详情、Findings 和关联 spans |
| Node | `--node <id> --view measurements` | 节点 Measurements，以及请求开始至节点结束的调用分组 |
| Node | `--node <id> --view timeline` | 同一窗口内的调用时间线 |

`--node` 需要 `--from`。`--span` 保留指定 span 的原始详情，只接受 default view。
`--view` 不改变采集范围。`--format text` 输出到 stdout，`-o file.txt` 则写入文件；
`--format json -o file.json` 输出 `{manifest, result}`，result 保留每条 trace 的选中 view、采集范围和完整性。
HTML、Bundle、manifest 和缺省 HTML + Bundle 交付继续可用。默认 HTML 的共享导航保留 Agent 页面。

```sh
# 采集一次，保留可复用证据目录
doctor trace <id> --format manifest -o ./evidence
# 在已保存证据上选择视角，不加载 Plugin，也不连接 Kubernetes / OpenSearch
doctor trace --from ./evidence --view agent --format text
doctor trace --from ./evidence --node <node-id> --view measurements --format text
doctor trace --from ./evidence --node <node-id> --view timeline --format json -o ./timeline.json
doctor trace --from ./evidence --node <node-id> --view timeline --format html -o ./timeline.html
```

Node ID 从 default/agent 文本中的 `nodes` 源引用或 `tree.json` 获取；Agent 视图可能包含合成展示行，
其 `id` 不一定是原始 Node ID。批量证据中 ID 有歧义时，使用单条 trace 的 artifact manifest。
没有 AgentRun 提取结果时，agent view 明确显示 `not_available`。

## 本地分析与边界

`analysis.json` 使用 Doctor snapshot schema 2，保存标准化数据和采集时的 default/agent 展示投影，
离线不会重新执行业务提取器、Detector 或加载新的 Plugin。节点调用明细可从保存的 Measurements 和调用来源
按需准备，再由 Trace Harness 的同一个 View 渲染成 text、JSON、HTML。`view.json` / `view.txt` 保存选中视图，
根 `views.json` / `views.txt` 汇集批量结果，manifest 只索引文件。
旧 schema 不做兼容；可用 `--trace-file spans.jsonl` 重新导入原始数据，纯文件导入仅使用通用语义。

部分下载或单 span 采集不生成全 trace 的累计耗时分析。输出保留 scope、complete 和失败/部分完成状态；
没有完整证据时，不把缺少调用解读为没有发生调用。
同类总耗时可识别重复调用，时间线可观察串行、重叠和截止点；父子及并行调用的耗时可以重叠，
不能把各组总耗时相加当成 wall-clock，也不能仅凭最长调用认定因果上的瓶颈。
