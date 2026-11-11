# 配置与目标

有效配置遵循 [全局配置优先级](../../AGENTS.md#全局配置优先级)：CLI 显式参数优先于 profile，
profile 优先于默认值；选定值失败时不回退到其它目标。本文说明来源解析、目标身份以及宿主传递。

## 参数来源与宿主传递

Kubernetes 连接参数在根命令统一声明，通过 Commander 全局选项传入 CommandContext；子命令不重复
声明，不借进程环境变量传播目标。参数解析和 Help 构造不触发环境访问。

CLI adapter 保留 Commander 参数来源，在共享 Command 准备入口消除被 profile 覆盖的默认值；
领域 resolver 仍负责字段校验与来源记录。新增 profile-backed 参数时，应同步更新入口的字段映射。
Chat 校验、Skill 目标注入和远端 kubeconfig 上传使用本次调用的有效目标，不直接复用原始 profile。
本地 Skill 可读取 `TARGET_KUBE_CONTEXT` 并作为 `--context` 传给 Doctor/kubectl。
远端 Chat 协议不携带 context，因此显式 `--context` 会报错；可传入已设置 `current-context` 的 kubeconfig。

宿主或 Skill 将业务环境名解析为通用参数后交给 Doctor；Core 负责应用同一优先级与校验规则，
不解释 AS 等产品的环境名。目标选择与后续访问应使用同一份有效配置，目标展示应能说明实际值及来源，
便于使用者确认本次访问对象。

## Environment 与配置来源

先按 `CLI kubeconfig > profile kubeconfig > KUBECONFIG > ~/.kube/config` 选定访问配置；
选中来源后检查文件是否可读，缺失时直接报错，不换用低优先级目标。再用显式 context 或
该配置的 current-context 确定 Environment。profile 是配置来源，不是环境身份；不同 profile 指向
相同 cluster/context 时可得到同一环境身份，同一 profile 被 CLI 覆盖到其它集群时必须得到不同身份。
无效的高优先级配置直接失败，不尝试其它集群。

Core 只从选定配置读取 context 与 cluster endpoint，生成不含凭据的身份，并固定本轮使用的 context。
Command 的 EnvironmentContext 借用根 ClientManager；Service 绑定、WorkloadInstance 证据与 Plugin
客户端作用域使用这个身份。namespace 是环境内的访问范围，不作为 profile 名的替身。

## 相关入口

- [发行版](distribution.md#目标配置归宿主)：发行默认值与嵌入入口的目标配置。
- [Command 生命周期](command-lifecycle.md)：准备结果与本轮共享 Context。
- [Doctor Chat](../../docs/chat.md)：本地及远端会话的宿主边界。
