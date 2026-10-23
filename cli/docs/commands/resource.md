# Service 资源盘点

`doctor resource` 展示 Service 运行期间持续管理或使用的资源。它消费 Common 的 Resource 和
ResourceSnapshot；`kind` 是 Plugin 定义的开放类别，如 bed、sandbox、volume，`id` 是资源集合身份，
`name` 是展示名称。业务记录查询仍由 inspect/data 承担，基础设施 CPU/内存统计属于 compute。

## 使用

```sh
doctor resource                         # 全部声明资源，一页只读快照，默认终端摘要
doctor resource --kind volume           # 按类别筛选
doctor resource -s worker --resource worker-volumes
doctor resource --list --kind volume    # 静态目录，不访问现场
doctor resource -s worker --resource worker-volumes --cursor '<nextCursor>'
doctor resource --format json -o resources.json
```

支持 Service 别名和重复的 `-s`；选择先于环境访问，无匹配声明时明确说明。每个来源默认最多 100 个
实例、20 秒、1 MiB 快照；`--max-instances` 上限 1000，`--timeout` 上限 300 秒。
Core 不自动遍历 continuation，不为概览扫描全部资源。`--cursor` 必须唯一选定一个 Service/资源来源。
默认 summary 不创建当前目录报告文件；可显式选择 text、JSON、Markdown、HTML、Bundle 或 manifest。
输出复用 CommandSpec 的根 finalize，供未来 overview 组合复用。

## Plugin 接入

Service 通过 `resources: readonly ServiceResourceDefinition[]` 直接声明关联：

- `resource` 复用 Common 的 id/kind/name/description。
- `relationship` 为 manages 或 uses。同一资源集合可关联多个 Service，Core 不重复相加。
- `observe` 是原生 PluginOperation，声明 access 并返回带 Summary 的 ResourceSnapshot，不注册 Extension。

`observe` 使用共享 PluginContext：环境身份来自 `context.target.env`，凭据和传输通过既有
context/config/clients 取得，根 Command 持有客户端。读取必须只读，并在数据源端遵守 query 预算和
context.signal；资源详情只能包含可安全交付的 JSON，不得包含凭据。示例见
`plugins/example/src/resources.ts` 的 namespace 内 PVC 列举。

目录、身份、kind 与关联在载入时校验。调用后校验快照环境/资源身份、实例身份、数量/字节预算与
coverage；验证通过后复制为普通 JSON，Render 不再调用 Plugin 或访问现场。

## 覆盖与权限

`totalCount` 是该 scope 独立取得的总量，不能拿当前页长度替代；未知值省略并展示“未知”。
Measurement 保留 unit 和 observed/total 口径，实例 state 是业务状态，不生成健康 Verdict。
分页结果必须标记 partial 并携带 nextCursor；独立总量可与部分实例列表共存。

每个来源独立记账。统一 ToolboxError 的 permission_denied 展示为“无权限”，记录 kind/code，
继续读取其他来源；不尝试扩大权限、不把未知填成 0。它是预期的观测缺口，命令保留 partial 结果。
其他失败同样保留已有结果；Ctrl+C 向观察者传递取消并停止后续来源。
