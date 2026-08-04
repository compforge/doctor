# doctor debug image Release Notes

版本号单一来源是同目录的 `VERSION`。镜像版本独立于 Doctor CLI；构建时同时把 debug image 版本和构建所用 CLI 版本写入 `/opt/doctor/manifest.json`。

## 0.0.12

- 增加人工网络探测工具：curl、dig/nslookup/host、OpenSSL、netcat、socat、ping、mtr、tcptraceroute、strace 与 jq；结合已有的 ip/ss 和 tcpdump，可在目标 Pod network namespace 内兜底检查 DNS、路由、TCP、TLS 与 HTTP。
- 镜像 manifest 增加对应工具能力声明，构建时校验全部命令存在。

## 0.0.11

- 新增 tcpdump、iproute2 与 `/opt/doctor/bin/net-capture`。控制器按 session 管理 tcpdump，支持启动、状态、停止、metadata、清理以及独立 watchdog，按超时或容量边界自动 SIGINT 停止并计算 PCAP SHA-256。
- debug ephemeral container 统一申请 `SYS_PTRACE` 与 `NET_RAW`，同一 runtime 同时服务进程取证和 Pod network namespace 抓包。

## 0.0.10

- PyHeap dumper / analyzer 升级到 `0.7.0+doctor.2`；retained heap JSON 增加容器元素类型画像和有限入站引用路径，供 Doctor 识别 Python runtime cache 等已知 owner。
- PyHeap UI 兼容未采集字符串表示的 lite heap，查看对象详情时以 `Not captured` 展示，不再因空字符串表示报错。

## 0.0.9

- doctor debug image 采用独立版本源；本版包含 Alpine、Python 3、支持 Python scripting 的 GDB、Austin 4.0.0、py-spy 0.4.2，以及 PyHeap dumper / analyzer 0.7.0+doctor.1。
- 新增 `/opt/doctor/bin/pyheap_analyzer`，支持把 `.pyheap` 转换为工具中立的 `pyheap.analysis/v1` JSON，并在构建时校验 `retained-heap` 子命令可用。
- manifest 新增 `debug_image_version`，并保留 `doctor_version` 记录构建所用 Doctor CLI 版本。

## 0.0.8

- 初始 registry 版本，提供 Alpine、Python 3、支持 Python scripting 的 GDB、Austin 4.0.0、py-spy 0.4.2 和 PyHeap dumper 0.7.0+doctor.1。
