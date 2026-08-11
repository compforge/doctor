# Store 诊断

## 理念 / 概念

`doctor store` 统一诊断 DB、VDB、S3 与 Redis 的健康和容量。一次运行可选择一个或多个 Store 类型，
随后分别选择提供配置的业务 Service；Store 的访问身份来自所选 Service Pod，不由 doctor profile
另配一套凭据。

Service Catalog 的 `stores` 描述“这个 Service 可能提供哪些 Store 配置契约”，用于生成候选和解释
环境变量；它不代表当前部署已启用该能力。只有运行时 endpoint、目标名和凭据等必需值完整时才连接
Store。配置缺失或空值表示当前未启用，Evidence 记录为 `unavailable`，不会被误判为凭据错误或健康故障。

`doctor data` 负责按业务 ID 汇集数据；其 Service data capability 引用同一份 DB Store capability，
避免业务数据查询与设施诊断各自维护环境变量前缀。

Redis 已作为 `doctor store` 的一种类型，保留拓扑、容量、压力窗口与 keyStats 探测链。S3 对象画像只
参考它的“有界扫描、Top-N、完整/部分覆盖”设计，不复用 Redis key 采样代码；两类存储的 API、
排序语义和容量边界不同。

## 流程

1. 交互多选 DB、VDB、S3 或 Redis；自动化调用用逗号分隔的 `--type` 指定。
2. 从 Service Catalog 中筛出声明该类 Store 的 Service，并与当前 Namespace 中已部署的 Service 取交集。
3. 选择 Service、Store capability 和 Running Pod/container。
4. 优先读取所选 Container 明确引用的 ConfigMap、Secret、env 与挂载配置；声明配置不足时才回退
   `pods/exec env`，并在内存中拼出运行时连接身份。
5. Inspect 将脱敏配置和访问通道固化为 Facts；必需配置不完整时结束为“当前未启用”。配置完整时，
   各 Store Probe 通过 Doctor Host 到后端的只读通道产出健康、容量、负载或数据画像 Observations。
6. Detector 只基于 Facts/Observations 生成 Findings，Coverage 独立说明本轮各诊断目标的证据是否充分；
   DB、VDB、S3、Redis 都走这条共享主链，规则与报告阶段不再访问现场。
7. 成功诊断默认交付单文件 HTML。单选时直接输出该 Store 报告；多选时继续执行其余类型，并把
   DB、VDB、S3、Redis 的自包含报告合并到同一个 Tab 页面。显式选择 bundle 或 Markdown 时仍按类型
   分别交付，因此多选不接受单一 `--output`；HTML 多选只有一个总报告，可以指定统一输出路径。
   Store 只取得部分证据时仍交付对应报告，并醒目标记 partial、缺失证据及结论边界；完全无法形成
   可用诊断或产物交付失败时，才降级交付失败 Evidence Bundle。

## 关键设计

### Catalog 声明契约，运行时决定状态

Store capability 归 Service Catalog，因为“哪个 Service 用什么配置契约访问哪类存储”是稳定的 Plugin 知识。
是否启用则属于具体部署的运行时事实。这个边界允许 Service 始终声明 S3 契约，同时用
空配置明确表示数据持久化未开启。

### 不同 Store 分别定义容量边界

- DB 首版实现 MySQL：用应用账号执行只读连通性查询，统计目标 schema 的逻辑数据、索引和 Top 表；
  对 `SHOW GLOBAL STATUS` 取两次短窗口快照，计算 QPS/TPS、读写、慢查询、临时表落盘和连接失败增量，
  同时观察连接上限、活跃事务与锁等待。累计计数发生重置时不生成虚假速率。物理磁盘总量、剩余量和
  容量增长趋势仍需要数据库平台历史指标，不能从应用账号伪造。
- VDB 当前实现 OpenSearch：健康、shard、data node 磁盘、水位线与 index 写保护分别采集和判读。
- S3 以 AWS S3 兼容 API 验证 bucket 访问并采集对象画像；识别出具体 Provider 后，再按其声明的扩展
  能力补充健康、容量或平台指标。对象画像通过 `ListObjectsV2` 只读取 key、size、LastModified，按前缀
  层级、年龄段和文件扩展名聚合，帮助判断空间归属和删除老数据的理论收益，不读取对象内容。
- Redis 以每个 master 的 `INFO memory` 为容量边界；Cluster 的名义总量不能掩盖单个 master 已满。
  `maxmemory=0` 只表示 Redis 未配置内部上限，不能据此判断 Pod、cgroup 或宿主机仍有空间。

### Redis Facts、容量与压力窗口

Redis 的运行时环境、地址来源、凭据来源、声明拓扑、TLS 和客户端连通性属于行动前 Facts；真实拓扑、
节点状态、内存容量和 keyspace 分布属于连接后取得的 Observations。带密码的 target 只留在本轮执行态，
Evidence 只接收脱敏 endpoint、username 和 credential source。target/capability Fact 不可用时 Probe
不运行，但 detector 与 renderer 仍生成证据缺口，不把“未启用”伪装成健康故障。

容量诊断不依赖 key 扫描：Detector 用 Redis 实际计入 eviction 的内存与 `maxmemory` 比较，并结合
eviction/OOM 后果判读。短压力窗口始终采集；只有容量偏高、短窗口出现 eviction/OOM 或已有容量后果时，
才升级到更长的独立观察窗口。正常实例不增加等待，未执行窗口明确记为 unnecessary。累计计数只能说明
历史上发生过后果，不能单独证明当前仍满。

Redis database 是 key 命名空间，深度扫描只属于选定 database；节点内存、maxmemory、eviction 和 OOM
仍是 master 级指标。Cluster 只支持 db0，不能把节点级容量伪装成某个 database 的内存结论。

### Redis Key 探测有界且独立

Key 分析同时受总检查量和速率预算限制，并在多个 master 间分配额度、串行检查；达到预算时保留 partial
Observation 和真实覆盖声明。小 keyspace 或采样比例较高时用 SCAN，低采样比例的大 keyspace 改用有界
RANDOMKEY 去重，使选 key 的服务端工作量随采样预算增长，而不是先遍历完整 keyspace。随机选择和后续
元数据读取共用速率边界。Top-N key 默认保留名称以便定位，跨团队流转时可显式关闭名称，仅保存前缀与摘要。

Cluster sample 发现 master 数据集明显倾斜时，独立 keyStats Probe 只深入最大的 master；显式启用时
检查全部 master。keyStats 采用 `SCAN/RANDOMKEY → TYPE → MEMORY USAGE → 类型长度命令`，仍受批次、pipeline、
速率和总量预算约束。只有完整扫描时，detector 才能用解释内存差值的最小 Top key 集合形成根因 Finding。
overview、node 与 keyspace 虽是不同 Observation 类型，但来自同一次受限访问，不为目录对称拆成重复连接
和扫描的多个 runtime Probe。

### S3 健康与容量独立

对象存储的 liveness、readiness、读写 quorum 与 S3 API 可以全部正常，但磁盘已接近耗尽。因此 S3
结论同时保留 bucket 访问、provider 健康和物理容量三组事实；容量告警不会被 HTTP 200 覆盖。默认探针
保持只读，不创建 canary 对象。

### AWS S3 API 是共性，Provider Adapter 表达差异

AWS S3 API 是对象存储诊断的共同协议基线：endpoint、region、访问密钥和寻址方式组成访问身份，
`HeadBucket`、`ListBuckets`、`ListObjectsV2` 与 bucket versioning 等标准操作承载通用探测。AWS S3、
MinIO、Ceph RGW、Cloudflare R2、Backblaze B2、DigitalOcean Spaces 等实现都可先走这条主链；未识别出
具体厂商只表示没有可用的扩展 Adapter，不表示标准 S3 能力不可用。

“兼容 S3”不等于所有管理面能力一致。不同 Provider 对 ListBuckets 权限、versioning、path-style 与
virtual-hosted-style、region 语义及部分 API 的支持范围可能不同；物理集群容量、健康端点、Bucket Usage
Metrics 等更不属于通用 S3 数据面。Inspect 因此把 Provider 身份和扩展能力固化为 Facts，Probe 只调用
已声明的能力；当前 MinIO Adapter 补充其健康、Metrics 和 Tenant 容量，Collect、Detector 与 Renderer
不直接依赖 MinIO 协议。未来增加其它 Provider 时也只扩展 Adapter，不复制标准 S3 扫描链。

### 对象画像有预算，也有覆盖声明

同步 `ListObjectsV2` 每页最多返回一批对象，Doctor 默认受对象数和总时间预算约束；可用
`--s3-max-objects`、`--s3-scan-timeout` 调整。Doctor 扫描凭据可见的 bucket，并优先覆盖 Service
点名的 bucket 和 prefix；`--s3-prefix` 用于显式限定所有 bucket 的扫描范围。

Doctor 先用 delimiter 发现 bucket 下的一级 Prefix。Prefix 数量未超过内置阈值时，在总预算内逐个完整
翻页；数量较多时，为每个一级 Prefix 分配公平样本，再按样本逻辑容量展示 Top-N。每个入选 Prefix
继续聚合第二级 Prefix、Top Object、对象年龄和扩展名分布。只有完整翻页到结尾时，容量占比才是确定
结论；采样或预算耗尽时结果标记为 partial，并明确说明容量与占比只代表样本。大桶长期治理优先消费
平台已有的 S3 Inventory；它是离线清单，不把同步 List 请求压力施加到在线 bucket。

S3 HTML 按诊断摘要、物理容量、Bucket 容量、一级 Prefix 容量、Prefix 下一级 Object、Inspect Facts 和
采集步骤组织；Bucket 与一级 Prefix 采用联动选择，并共用同一次对象扫描口径，避免把 Provider 的异步
Usage Metrics 与当前 Prefix 样本混在同一张图中。Provider Metrics 仍作为证据和扫描排序参考。

LastModified 表示对象创建或最近一次修改时间，不保证等于业务首次写入时间。`ListObjectsV2` 只覆盖当前
对象版本，也不含未完成 multipart upload；若 bucket 开启 versioning，删除当前对象可能只新增 delete
marker，旧版本仍占空间，因此报告会单独提示 versioning 状态。对象画像给出的是逻辑字节，MinIO Tenant
给出的是 raw 物理使用量，两者受纠删码、副本和后台回收影响，不能按一比一换算。

### VDB 访问通道复用

VDB 的业务配置是“该 Service 实际连接哪个 VDB”的 target Fact；Kubernetes Service 发现是 Doctor Host
如何访问它的通道准备。OpenSearch 通道与 Trace 共用 `collect/shared/opensearch-access`，但两个领域互不
依赖；配置中的 endpoint namespace、port 与 scheme 保持权威。

标准部署直接读取 `OPENSEARCH_*` 环境变量。Plugin 使用自有挂载文件或配置结构时，由 VDB Store capability
声明文件定位规则并把内容投影成统一 target；Doctor 只负责从所选 Service Pod 取得配置材料，不理解 Plugin
配置 schema。这样固定路径、字段和选择规则留在具体 Plugin，后续增加 Plugin 不会继续扩张 CLI 分支。

### 单项失败保留其余证据

健康与容量探针独立记账。某个 API 被权限拒绝或 provider 不暴露容量时，其余结果仍进入 Bundle；缺失证据
明确标记为 partial 或 unavailable，不用猜测值填补。

Renderer 直接消费共享 Diagnosis：Markdown 保留完整表格，HTML 从结构化 Observation 生成容量、TTL、
Top-N 等可视化，Bundle 保存 probe JSON、findings、摘要和 manifest。HTML 不从 Markdown 或 Finding 文案
反向解析数据；Finding 的结构化 `kind` 才是 detector 与 renderer 的稳定协议。
