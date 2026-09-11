# Command 渲染与报告组合

跨 Command 生命周期与领域边界见 [Kernel](kernel.md)。本文约定报告结构、四种阅读场景与离线交付。

## 理念与概念

Command 同时拥有执行结果的领域语义和结果的阅读方式。领域 Command 决定自己的页面布局；聚合
Command 决定如何组织子 Command 的报告。命令调用树表达执行依赖，报告结构表达阅读路径，两者
不要求一一对应：Collect 的纯编排层不必额外占用导航，Overview 则有自己的概览内容。

| 概念 | 所有权 |
|---|---|
| Output / ItemResult | Command 的领域结果、每项状态及关联身份；单项是长度为一的批量 |
| Artifact | 本次执行保留的证据、结构化结果及附件，具有独立身份和存储位置 |
| Report | 可组合的阅读结构：页面、分组、上下文、状态和对内容的引用 |
| Renderer | 把完整执行结果投影成 Report；领域布局和聚合组织都通过该入口表达 |
| Delivery | 将 Report 生成为最终阅读文件，并将报告及 Artifact 归档交付 |

HTML 是报告的呈现格式；`tar.gz` 是承载报告与证据的交付容器。Command 不各自实现打包函数，
聚合 Command 也不把子命令的 tar 包再次套进父包。归档布局继续由 Delivery 根据 Artifact 引用统一决定。

## Command 与数据的四种场景

Command 数量与业务对象数量是两个独立维度。报告保留这两个维度的语义，避免把数据提前固化成
只能按一种方向遍历的 tabs 树。

| 场景 | 导航组织 | 内容布局 |
|---|---|---|
| 单 Command、单数据 | 直接展示，身份放在页面上下文 | 由领域 Command 决定 |
| 单 Command、多数据 | 数据选择器定位结果 | 复用同一 Command 的页面布局 |
| 多 Command、单数据 | Command tabs 共享数据上下文 | 各 Command 保持自己的布局 |
| 多 Command、多数据 | Command tabs 与数据选择联动 | 根据当前 Command 和对象展示对应结果 |

Collect 默认采用 Command 优先的导航。用户在 Trace 选择请求 B 后切换至 Log，只要该 Command
支持同一对象，就继续定位请求 B。某对象没有对应结果时明确展示缺失或失败，不静默切到其它请求。
这套关联信息也能支持面向请求的阅读组织，无需重复采集或复制页面；双视图切换不是默认要求。

Inspect 的环境范围、Tenant 的租户范围、Metric 的 Service/时间窗口范围不伪装成 biz-id。
切换到这些页面时展示其真实作用域，共享结果只保存一份。对象与租户的关联必须来自已有结果，
报告层不通过额外查询推导关系。

业务 ID 与 trace ID 是关联身份，不自动构成两层必选导航。一个 conversation 对应一个 trace 时，
保留身份关联即可；对应多个 trace 时，由 Trace 提供进一步选择。

只有一个候选项的分组自动穿透，同时保留必要上下文。多个候选项才显示选择控件，深层选择使用
紧凑上下文而不是不断增加整行 tabs。目录名、时间戳和内部批次名只用于存储，不决定用户导航标签。

## 执行、渲染与交付流程

```text
CommandSpec.run
  → CommandResult：状态、Output / ItemResult、Artifacts
  ↓
根命令 Finalize
  → CommandSpec.render
      → 领域页面，或按需组合子 Command.render 的报告
  → Delivery
      → 单文件 HTML
      → 带根索引、报告和原始证据的 tar.gz
  → 临时产物清理
```

`CommandSpec` 声明 render 入口，具体实现仍位于 Command 所属模块。render 接收完整
`CommandResult<Output>`，因此即使执行失败而没有 Output，也能展示失败原因和已保留的证据。
渲染所需的目标、显示身份及配置摘要随结果保留，不从当前环境重新推导。

子 Command 的 run 不自动渲染或交付。根 Finalize 触发根 render；聚合 renderer 使用受控的子报告
渲染入口组合结果，不重新运行命令。Trace/Log/Data 的领域交互归各自 renderer，Collect 的组合方式
归 Collect renderer，Overview 的概览与采样结果关联归 Overview renderer。

RenderContext 只提供本地证据读取、子报告渲染与复用等能力，不暴露数据库、Kubernetes 客户端或
命令执行能力。远端 Client 可以在执行结束后释放；渲染会用到的本地证据必须保留至交付结束。
报告写出失败时仍保留源产物，以便重新生成报告。

## 关键设计

### 统一契约，保留领域布局

CommandSpec 将 run 和 render 绑定到同一个 Output 类型，避免另一份 command-to-renderer 注册表。
执行组合与展示组合分别由 run、render 拥有；共享报告模块负责导航、页面容器、加载状态和基础组件。
Trace 的树/详情/火焰图、Log 的时间线和筛选、Data 的记录与关系仍由领域实现决定。

### Report 的结构

`Report.sections` 是命令阅读区域；每个 `ReportSection` 持有稳定 ID、显示标题、采集状态、可选共享
scope 和页面列表。`ReportPage.subject` 显式关联业务对象，`source` 用 Artifact ID 与相对文件名定位
本地页面；无可用页面时保留原因。`renderError` 单独表达渲染失败，不覆盖采集终态。

Trace / Log / Data 从批量结果生成逐项页面；Inspect / Tenant / Metric 使用已保存的 Diagnosis。
Store 和 HTTP 也可保存脱敏后的本地展示投影，renderer 使用同一报告 shell 生成页面。聚合层只组合
这些引用，视图内容按哈希去重存储，引用本身按页面 ID 与业务对象保留。

### 显式引用替代扫描和反解析

Report 直接引用 Artifact 的视图，例如以 Artifact ID 与 view key 定位一个页面。聚合 renderer
组合结构化引用，不先生成完整子 HTML 再由父级解压、解析并恢复导航。是否有独立阅读页面是显式声明，
不能仅凭 Artifact 目录里是否存在 `report.html` 推导报告结构。

页面身份与导航位置分开：一份共享页面可以被多个阅读上下文引用。内容哈希只用于存储去重，不能
因为两份 HTML 恰好相同而删除一个业务对象的导航。Artifact ID 继续表达证据身份，输入幂等 key
继续表达执行复用；二者不替代报告中的对象关联。

### 一次执行的报告按需复用

根渲染阶段为同一执行结果复用子报告，包括进行中的渲染。Inspect/Tenant 等幂等命令
返回原结果后，多个父级引用同一报告即可，不需要识别第几次 Collect。缓存只属于当前渲染阶段，
不按同一个输入 key 跨执行复用可能已经变化的现场。

### 采集、诊断与交付状态各有含义

采集终态沿用 CommandStatus；Finding/Coverage 保留目标异常和证据完整度；页面加载与文件交付
有各自结果。成功写出 HTML 不意味着采集完整，更不意味着目标健康。

失败、取消或没有生成页面的业务项仍保留在 Report 中，说明原因及可用证据。单个子 renderer
失败只影响其页面，其他子报告仍可交付。渲染或归档失败不能抹掉已经取得的原始证据。

### 单文件与按需加载同时成立

最终 HTML 仍可离线双击打开，运行资产全部内嵌。共享容器保留紧凑索引，按选择加载页面，切换时
释放前一个页面；Trace 内部的树骨架和节点/span 详情分片仍由 trace-harness 负责。

浏览器只保留当前页面的活动对象；压缩内容仍随文件驻留，不承诺任意文件大小。保持领域脚本隔离，
不因组合报告让叶子页面获得外部资源或外层页面访问能力。

Doctor 与 trace-harness 可复用离线内容归档和读取原语，但 Command、业务对象选择与报告组合语义
属于 Doctor。通用报告能力归报告公共层，不归基础设施 Client/Transport 工具箱。

## 验证边界

共享测试覆盖四种场景，并验证独立运行和聚合运行使用同一领域页面。浏览器验证至少包含：

- 单项不出现冗余导航，完整身份仍可查看。
- 跨 Command 切换保留适用的对象选择；共享作用域正确显示，缺失结果不被替换。
- 一个 conversation 对应多个 trace 时可独立选择，失败项仍可见。
- 同一证据被多处引用时只存一份，不丢失有效导航和关联上下文。
- 大报告反复切换不会同时挂载全部页面，节点详情仍可完整查看，离线打开不发外部请求。
- 子 renderer 失败、取消以及交付失败时，保留其他结果和原始证据。

静态 HTML 字符串断言只能证明输出结构的一部分，不能代替最终导航与加载行为的浏览器验证。
