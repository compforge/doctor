# doctor net 网络取证

## 理念 / 概念

`doctor net` 面向一次短时网络观测会话采集服务间的真实网络证据。操作者按本次问题选择要覆盖的 Service，
例如围绕 `entry → service-a → service-b → backend` 的某几跳判断哪里变慢、中断、提前结束或返回错误。
它不是长期网络监控，也不尝试用 trace 推测报文内容；trace、日志与 PCAP 是可以互相校验、
但不能互相替代的证据。

网络诊断拆成三个独立生命周期：

| 命令 | 职责 | 主要产物 |
|---|---|---|
| `doctor debug` | 向目标 Pod 准备或复用空闲的通用 debug environment | 具备抓包工具和权限的调试环境 |
| `doctor net` | 发现拓扑、协调短时抓包，以跟踪或守候方式形成观测会话 | NetBundle |
| `doctor neta` | 纯离线重组 TCP/HTTP/SSE，从观测会话中定位请求并执行诊断 | 网络调用栈与分析报告 |

debug environment 准备后保持空闲，不自动抓包。一次抓包由 `NetworkCaptureSession` 表达，session 拥有目标 Pod
集合、开始/结束时间、采集模式、可选的染色/trace ID、资源预算和全部远端 artifact。`doctor net`
是 session 生命周期的唯一 owner；debug environment 只提供受控的 start/status/stop/metadata/cleanup
执行能力。

`X-Doctor-Capture-ID` 一类染色 Header 是应用层关联键，不是 tcpdump 的抓前过滤条件。抓包时只能按
时间、协议、端口和地址做粗过滤；精确请求提取发生在 TCP/HTTP 重组之后。染色 Header 若能在服务间
持续透传，优先用它关联各跳；否则退化为 trace ID、时间窗口和连接五元组联合关联，并明确降低置信度。

## 流程

### 1. 发现目标与确认前置能力

`doctor net` 先由操作者确认本次要覆盖的 Service，再解析对应 Endpoint、Pod、业务容器、Pod IP、端口和节点信息。
交互终端未指定 `--services` 时列出当前 namespace 的 Service 供多选；非交互调用必须显式传入。
负载均衡会把请求送到任一副本，因此默认覆盖目标 Service 的全部 Ready Pod；现场可以主动缩容副本来
降低抓包规模，但这不是正确性的前置条件。

拓扑解析完成后、任何 runtime readiness 或 ARM 操作之前，Doctor 在终端列出最终
`Service → Running Pod` 覆盖范围。Service 是否属于本次排查由操作者决定，Doctor 不内置必选或可选服务；
一旦选入范围，该 Service 的缺失或无 Running Pod 就作为本次证据缺口。

每个目标 Pod 必须已经存在由 `doctor debug` 准备的兼容 runtime，并通过以下事实检查：

- 临时容器 Running，且与业务容器共享目标 Pod 的 network namespace；
- 抓包工具和控制程序 ready；
- 具备有效的抓包 capability；
- 远端目录和本地目录有足够的有界空间；
- `pods/exec` 与文件回传能力可用。

缺少 runtime 时命令停止并列出需要准备的 Pod，不在采集过程中隐式注入临时容器。若所选 Pod 全部只缺
runtime、抓包尚未开始，终端把已经选择的 profile、namespace 和 Service 范围渲染为可直接执行的
`doctor debug --services ...`，且不生成没有 PCAP 的失败 Bundle；已开始抓包或存在其它覆盖缺口时仍保留
失败 Bundle。镜像发布、Pod mutation 与网络取证因此保持为可见的不同操作。

### 2. 建立 NetworkCaptureSession 并统一 ARM

`doctor net` 为本次诊断生成 session ID 和染色 ID，然后并发要求各 debug environment 启动 tcpdump。
底层抓包保持完整包长、流式写盘并设置缓冲区、超时、文件大小等资源边界；BPF 只使用协议、服务端口、
Pod/对端地址等内核可可靠判断的条件。过滤条件必须考虑 Service DNAT 后实际可见的 Endpoint 地址，不能
假设 PCAP 中仍然出现 Service ClusterIP。

控制程序异步启动 tcpdump，将 PCAP、PID、日志和状态写入 session 独占目录。所有目标必须进入
`ARMED` 后才允许发起请求；部分 Pod 启动成功、部分失败时不继续触发业务请求，以免产生不可补回的证据缺口。

```text
READY → ARMING → ARMED → TRACKING 或 WATCHING → DRAINING → STOPPING → COLLECTED
```

### 3. 选择跟踪或守候

`doctor net` 有两种观测模式，但共享同一个 NetworkCaptureSession、抓包 barrier、回传和 NetBundle 协议：

- **跟踪**：选择或显式传入 `doctor-http/v1` YAML，目标请求在抓包前已经明确；Doctor 在全部 Pod ARMED
  后注入染色 Header、发起其中一个 HTTP/SSE 请求，并跟踪它经过哪些服务。
- **守候**：交互选择 YAML 时直接回车，Doctor 只知道需要布控的 Service，不主动发请求；全部 Pod ARMED
  后等待操作者完成页面操作，
  操作者回到终端按回车后进入 drain 并停止抓包。

跟踪模式一次只执行一个请求；场景解析出多个 request/entrypoint 时交互选择一个，非交互调用仍要求场景
只解析出一个。交互终端未指定 `--file` 时扫描当前目录并列出通过 schema 校验的 YAML；即使只有一个候选
也不自动选择，直接回车始终表示守候。当前目录没有候选时直接进入守候。非交互环境不会等待人工操作，
仍要求显式传入 `--file`。

跟踪模式下，请求与响应同时落盘，至少保留：

- 原始 YAML、实际请求计划摘要与染色 ID；
- 响应 headers、原始 body/SSE 和 transport error；
- HTTP 状态、开始/结束时间和终止原因；
- 从响应 Header 或 SSE Event 中提取到的一个或多个 trace ID。

跟踪模式可以依靠染色 ID 精确关联；守候模式则依靠短时间窗口、抓包范围和可见 HTTP 请求发现候选调用，
因此可能包含多条业务请求，Coverage 必须明确 TLS、背景流量和目标请求无法区分造成的不确定性。

### 4. drain、停止与回传

客户端响应结束不代表最后一跳的包已经全部写入 PCAP。`doctor net` 先进入有界 drain，再向全部 runtime
发送 stop。停止 tcpdump 使用 SIGINT 并等待退出，使 PCAP trailer 和用户态缓冲正常落盘；强制 kill 只作
超时后的失败兜底，并在 metadata 中留下不完整标记。

正常、请求失败和本地 Ctrl+C 都通过同一个 `finally` 路径停止全部 session。远端 watchdog 与本地进程
生命周期解耦：Doctor 进程崩溃或连接中断时，watchdog 也会在预算到期后停止 tcpdump，避免无限抓包和磁盘增长。

停止后逐 Pod 回传 PCAP、tcpdump 日志和 metadata，校验大小与摘要，再形成 NetBundle。远端 artifact
默认在成功回传后才允许清理；采集、停止、传输或校验失败时保留现场路径，供人工补取。

守候模式收到操作者回车后，终端按 drain、停止抓包、读取 metadata、回传并校验 PCAP、打包 NetBundle
依次报告进度。多个 Pod 的文件传输仍限制并发，但用一条聚合字节进度表示整体完成度；每个 Pod 的开始、
完成和重试作为独立日志插入。这个阶段不执行流量分析，NetBundle 生成后由 `doctor neta` 离线分析。

NetBundle 的 artifact integrity 与诊断 Coverage 分开判断：文件成功回传并通过摘要校验，表示该 PCAP
可分析；因容量或时限停止只表示预期窗口末段未被观察，不破坏停止前 PCAP 的完整性。前者决定采集命令
能否成功交付 NetBundle，后者由 `doctor neta` 作为 `capture-scope` Coverage 呈现，不阻止分析报告生成。
`doctor neta` 只有在所有 PCAP 都无法成功解码时才返回分析失败。

```text
net-<session>/
├── manifest.json
├── request/（仅跟踪模式）
│   ├── request.yaml
│   ├── request-plan.json
│   ├── headers.txt
│   ├── body.<type>
│   └── error.txt（失败时）
└── pods/
    └── <namespace>_<pod>/
        ├── capture.pcap
        ├── tcpdump.log
        └── metadata.json
```

文件名和具体字段以代码 schema 为准；稳定契约是 manifest 必须能说明每份 PCAP 来自哪个 Pod、覆盖什么
时间、是否完整、如何校验，以及哪些预期目标没有成功交付。

### 5. `doctor neta` 离线分析

`doctor neta` 不访问 Kubernetes，也不修改 NetBundle 中的原始证据。它按以下顺序处理：

1. 校验 manifest 与文件摘要，建立 Pod、地址、端口和采集时钟索引；
2. TCP 重组和重传去重，识别 FIN、RST、半关闭与未完成连接；
3. 在协议允许时解析 HTTP request/response、chunked body、SSE 与 OpenAI-like chunks；
4. 跟踪模式先按染色 ID 或 trace ID 定位目标消息；守候模式重建窗口内所有可见 HTTP 请求，再用连接、
   时间和服务拓扑组织候选调用；
5. 将重复抓到的同一连接视为多观察点，不误报成两次业务调用；
6. Detector 根据同一份 Facts 与调用 Observations 生成 Findings/Coverage；
7. 输出每一跳的请求时间、持续时间、状态、终止方式和证据来源。

`doctor net` 的默认产物名为 `doctor-net-YYYYMMDD-HHmmss.tar.gz`。交互终端直接运行
`doctor neta` 时会扫描当前目录：唯一候选自动使用，多个候选列出供选择；也可以显式执行
`doctor neta <input>` 分析自定义名称或目录。非交互环境不猜测输入，必须显式传入 `<input>`。

一次用户请求可能产生多个 trace ID，也可能并行调用多个后端服务。分析输入因此是一个或多个 trace ID，
输出是有分支的调用图，而不是强行压成单链表。无法可靠关联的流量保留为候选边，并展示关联依据和置信度。

离线协议解析由 `infra/host/network-analysis` 提供统一事件契约，并按固定优先级选择 backend：分析机存在 `tshark`
时使用 Wireshark dissector，以取得 HTTP/2 等更完整的协议覆盖；否则使用匹配 Doctor Host 平台的 Toolkit
`doctor-pcap`，不要求客户另装系统包。该 backend 当前保证 PCAP、IPv4/IPv6、TCP 重组、明文 HTTP/1 Header/status、
FIN/RST 与 TLS record 时间线；HTTP/2、TLS 正文和更深的应用协议解析属于 tshark 增强覆盖。实际 backend 写入
版本化分析 JSON，Markdown 与单文件 HTML 只消费同一份 Diagnosis，避免不同机器、不同 renderer 的覆盖或结论
差异不可见。HTML 总控保持左侧目录与中间展示两栏；从调用泳道或时间瀑布选中一次调用后，打开可拖动位置和
调整大小的 HTTP Exchange 浮窗，以总览、Request、Response、Stream 和 Timing 分层展示。Request 下的 cURL、Preview
与 Raw，以及 Response 的 JSON Preview 都是可见报文的派生展示；SSE 按完整事件提供 Preview 和逐事件 Raw，
同时保留整条 Response Raw，未遇到事件分隔符的末尾片段不会伪装成完整事件。HTTP 错误、缺失 Response、
Body 截断分别显式标记，不用空白或补造内容掩盖失败。这个 HTTP Exchange 展示边界也为后续基于 HTTP 的 MCP
语义渲染预留扩展点。逐帧技术时间线下沉为可检索明细。两条解析路径都不进入业务 Pod，也不改变 NetBundle
原始证据协议。

## 关键设计

### `doctor net` 与 `doctor neta` 为什么独立

两者独立不是因为 PCAP 分析天然很耗资源，而是因为观测会话的触发者不总是 Doctor。跟踪模式下 Doctor
可以控制已知请求；守候模式只能先建立抓包 barrier，再由用户完成页面操作并显式结束。`doctor net` 因此只负责
现场 NetworkCaptureSession 的完整性和 NetBundle 交付，`doctor neta` 统一负责请求发现、关联、Detector 和报告，
避免跟踪与守候各长出一套分析逻辑。

采集完成后可以立即运行 `doctor neta`，但仍以已经封口的 NetBundle 为输入。这样现场连接中断或分析器失败
不会丢失 PCAP，新 Detector 也能重放历史证据；这与 Memory 因跨时间样本价值和高分析成本而拆分 `mema`
是不同的边界理由。

### 跟踪 / 守候是 Config，不是 Fact

跟踪或守候表达操作者本轮采用哪种诊断策略：前者围绕已知请求关联流量，后者在布控窗口中发现候选请求。
它决定 Probe 如何筛选调用、Coverage 如何解释“没有观察到请求”，但不是对目标环境的观察结果。因此该模式
随 NetBundle 和分析文档的 Config 传递，不进入 `inspection_facts`；Facts 只保留拓扑、Pod、抓包 artifact
和现场响应等可被证据引用的信息。这里选择 Config 而不是运行时 Context，是因为分析器离线重放时仍需知道
当时采用哪种策略；Context 中的 decoder、文件句柄和临时目录只服务本次执行，不构成分析素材，也不落 Bundle。

### 准备运行时与抓包控制分开

debug environment 会被 Memory、CPU、Network 等能力复用，不能因环境准备完成就持续采集流量。只有 `doctor net`
知道本轮目标、过滤条件、触发时刻和资源预算，因此由它显式控制短时抓包。`doctor net` 消费 Debug Fact，
不以子进程方式调用另一个 `doctor debug` 命令；两者通过稳定的 Host/Target infra 契约衔接。

### 抓前粗过滤，抓后精确提取

tcpdump/BPF 位于传输层，不能可靠读取跨 TCP segment 的 HTTP Header，也无法读取 TLS 内的 Header。把染色
Header 拼进 BPF 会产生随机漏包。正确模型是：

```text
短时间 + 目标 Pod + TCP/端口粗过滤
  → 完整 PCAP
  → TCP/HTTP 重组
  → capture ID / trace ID 精确提取
```

减少 PCAP 体积主要依靠短窗口、目标 Pod 范围、端口、滚动文件和总容量预算，而不是依靠应用 Header。

### 全 Pod barrier 保证证据窗口完整

请求路由在触发前未知，只抓一个当前副本会偶发漏掉整跳。所有目标 Pod 先 ARM、请求后统一 drain/stop，
用空间换确定性。每个 Pod 的启动和停止结果都写入 Worksheet；缺失某个必需 Pod 是 Coverage 缺口，不能
因其它 Pod 有数据就静默视为成功。

### 网络证据不能越过加密边界

明文 HTTP/1.1 可以重组 Header、chunked body 和 SSE；明文 HTTP/2 需要专门的 frame/stream 解析；HTTPS
中的 Header 和正文对 tcpdump 不可见，只能观察握手、连接时序、流量大小、FIN/RST 等传输事实。要解释加密
内容，必须在 TLS 终止后的明文侧抓取、获得合规的 session key，或引入显式应用层 capture/proxy；不能让
分析器假装解密成功。

因此实现前必须在目标环境确认各跳的 HTTP 版本、TLS 终止位置、压缩方式和染色/trace Header 传播情况。
这些是现场能力事实，进入 manifest 与 Coverage，不固化为业务链路永远明文的假设。

### 499 不一定存在于 PCAP 的 HTTP 响应中

499 通常是代理在 access log 中记录的“客户端在响应前关闭连接”状态，代理未必真的向已经断开的客户端发送
一份状态码为 499 的 HTTP response。`doctor neta` 必须分开报告：

- 报文中实际观察到的 HTTP status；
- FIN/RST、方向、时间和未完成 request/response 等连接终止证据；
- 来自 trace 或日志的 499 记录。

只有第一项可以称为“PCAP 中看到了 499”。后两项可以支持客户端提前断开的判断，但不能伪造成线上存在一份
499 response。最终定位仍可能需要把 NetBundle 与 `doctor log`、`doctor trace` 的时间线对齐。

### 原始 PCAP 是证据，调用栈是派生产物

PCAP、请求/响应和采集 metadata 保持原样；HTTP 对象、调用边和报告都是可重新生成的分析结果。分析器升级后
应能从旧 NetBundle 重跑，而不要求客户重新触发问题。原始业务正文可能包含提示词、模型输出、token、Cookie
和 Authorization，NetBundle 必须显式提示敏感性，并通过最小采集窗口、容量边界和受控交付路径降低暴露面。

### 复用既有 collect 与 infra 边界

- `collect/network` 拥有抓包范围确认、NetworkCaptureSession 编排、请求触发、Evidence/Detector/Render；
- `infra/target/network-capture` 只提供通用抓包控制和 metadata，不知道具体业务 Service；
- `infra/host/network-analysis` 提供稳定帧事件模型与单一 backend 选择入口，`tshark/` 和 `gopacket/` 只负责协议适配；
- `infra/target/debug` 提供已就绪 environment，`infra/k8s` 提供 exec、资源发现和文件回传原语；
- 请求执行复用 HTTP scenario/capture，不再实现第二套请求 schema、Fetch transport、SSE 落盘和 trace ID 提取；
- HTTP Request/Response 的有界证据模型与多形态 renderer 位于 `collect/shared/http`，network 只把 hop
  Observation 适配为 Exchange；HTML shell 只提供可选详情栏和选择联动。后续 MCP 等 HTTP-based 协议可复用
  Exchange renderer，并在领域层追加自己的语义 Preview，而不让 command 互相 import；
- `doctor neta` 是纯离线编排：PCAP Probe 只通过 `infra/host/network-analysis` 取得统一帧事件，Detector/Render
  不直接调用 tshark，也不理解 gopacket 输出细节。

`doctor net` 将采集模式、当时已经确定的拓扑、runtime readiness、抓包 artifact metadata 和可选的主动请求
结果写入 NetBundle Facts，并保留原始 PCAP。`doctor neta` 读取这些 Facts，由离线 PCAP Probe 物化 artifact
校验结果和 HTTP
调用 hop Observations；纯 Detector 再从 Evidence 生成异常 Findings，Coverage 独立表达哪些 Pod、协议或
加密边界阻止了完整分析。原始 PCAP 始终是权威证据，分析器升级后可重跑生成新的版本化 analysis JSON。

## 实现前验证项

方案的职责和生命周期已经闭合，但以下现场事实必须通过 dev 环境 spike 后才能进入实现承诺：

1. ephemeral container 在现有 Pod Security/runtime 下能否取得有效抓包 capability，并看到业务容器流量；
2. `-i any` 在目标 CNI 下的链路层格式、重复观察点、Service DNAT 与回环流量表现；
3. 各业务跳的 HTTP 版本、TLS 终止位置和 content encoding；
4. 染色 Header 与 trace Header 是否逐跳透传，SSE 中是否稳定返回一个或多个 trace ID；
5. 高并发背景流量下的 PCAP 增长、丢包计数、磁盘预算和文件回传速度；
6. Ctrl+C、本地进程崩溃、Pod 重启、tcpdump 异常退出和部分 Pod 不可达时，stop/watchdog/保留现场是否符合预期。

spike 的通过标准不是“能生成一个 pcap”，而是一次染色请求能够在所有明文跳上被稳定重组，缺失或加密的跳
有明确 Coverage，且任何失败路径都不会留下无限运行的 tcpdump。
