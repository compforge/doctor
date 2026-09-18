#!/usr/bin/env bun
import { commandOptionsWithSources } from "./option-sources";
import type { CollectHttpCliOpts } from "../collect/http";
import type { CollectNetworkCliOpts } from "../collect/network";
import { terminalStdout } from "../terminal/output";
// 入口只做子命令路由：
//   doctor chat              → 默认本地 Agent；--server 显式选择远端 Agent（app/repl.tsx）
//   doctor mem               → 选择后端、attach Python 进程并回传对象堆（collect/）
//   doctor mema              → 在本机解析并诊断一个或多个对象堆（collect/）
//   doctor cpu               → 无 server 直连采集：pod Python CPU 线程栈证据包（collect/）
//   doctor trace             → 无 server 直连采集：OpenSearch 下载 trace 全量 span（collect/）
//   doctor store             → 从 Service Pod 提取 Store 配置并诊断 DB/VDB/S3/Redis（collect/）
//   doctor log               → 按 Service / 时间范围采集 Pod 日志；可选 biz ID 关联 trace（collect/）
//   doctor data              → 先扩展业务 ID，再汇集各 Service 声明的数据（collect/）
//   doctor tenant            → 汇总租户配置与可用模型目录（collect/）
//   doctor collect           → 集合命令：选择并编排具体 collector，自身不实现具体采集
//   doctor inspect           → 检查 Service 的 workload 与配置（collect/）
//   doctor http              → 从 YAML 重放多轮 HTTP 请求并分析响应（collect/）
//   doctor net               → 协调目标服务 Pod 短时抓包并主动发起染色请求（collect/）
//   doctor mcp               → MCP tool 多维取证与规则分析（collect/）
//   doctor model             → 从模型目录选择目标并执行 validation/inference（collect/）
//   doctor metric            → 基于 Prometheus 或内嵌 Prombed 采集并可视化 Service metrics
//   doctor eval              → 按 canonical CaseSet 顺序触发请求，采集关联 trace/log/data，不做质量评分
//   doctor perf              → 发起受控业务压测，并在同一窗口采集 metric、trace、log
//   doctor install           → 向选定 Pod container 安装 GDB
//   doctor init              → 首次初始化 local profile
//   doctor profile           → 交互选择并持久切换 config.yaml.default_profile
// CLI 是多能力入口，bare `doctor` 显示本次构建选中的子命令帮助。
import { Command, CommanderError, type Command as CommandT } from "commander";
import { CliCommand } from "./cli-command";
import type { Distribution } from "./distribution";
import { applyCommandDefaults, deliveryFormatOption } from "./command-defaults";
import { DOCTOR_COMMANDS, selectVisibleCommands } from "./command-selection";
import { formatDistributionVersion, formatDoctorVersion } from "./version";
import { mapErrorMessage } from "../protocol";
import { type CollectTraceCliOpts } from "../collect/trace";
import { type CollectLogCliOpts } from "../collect/log";
import { type CollectDataCliOpts } from "../collect/data";
import { REDIS_DEFAULTS } from "../collect/redis";
import {
  NETWORK_DEFAULTS,
  runAnalyzeNetwork,
} from "../collect/network";
import { type CollectTenantCliOptions } from "../collect/tenant";
import {
  resolveCollectKinds,
  type CollectCliOpts,
} from "../collect/composite";
import { registerOverviewCommand } from "../overview/command";
import type { CliFlags } from "../protocol";
import { reportError } from "./error-log";
import { runInit } from "./init";
import { runProfile } from "./profile";
import { configureProfileHelp } from "./profile-help";
import { applyOptionDefaults } from "./command-defaults";
import { loadActivePlugin } from "../plugin";
import { registerPluginInfo, runPluginInstall, runPluginUninstall } from "./plugin";
import { runCommand, runStandaloneCommand } from "./command";
import { normalizeBizIdOptions, withBizIdInputs } from "./biz-id-input";
import { getDoctorHostInfo } from "../infra/host";

import { domainInput } from "../command/options";
import { chatCommand, imageCommand, debugCommand, installCommand, memCommand, memaCommand, cpuCommand, httpCommand, netCommand } from "./core-commands";
import { traceCommand } from "../collect/trace/command";
import { logCommand } from "../collect/log/command";
import { dataCommand } from "../collect/data/command";
import { inspectCommand } from "../collect/inspect/command";
import { tenantCommand } from "../collect/tenant/command";
import { metricCommand } from "../collect/metric/command";
import { storeCommand } from "../collect/store/command";
import { withDbOptions } from "../collect/db/options";
import { mcpCommand } from "../collect/mcp/command";
import { modelCommand } from "../collect/model/command";
import { collectCommand } from "../collect/composite";
import { evalCommand } from "../eval/command";
import { perfCommand } from "../perf/command";

type RawBizIdOptions<T> = Omit<T, "bizIds" | "bizId"> & { bizId?: string[] };

// REPL 选项只属于 chat 子命令，root 保持为中性的能力索引。
function withReplOptions(cmd: CommandT): CommandT {
  return cmd
    .option("-p, --profile <name>", "profile name from ~/.doctor/config.yaml")
    .option("--server", "use the doctor-server configured by the profile", false)
    .option("--resume [conv_id]", "resume a previous conversation (latest if no id given)")
    .option("-c, --config <path>", 'Doctor 配置路径；空字符串禁用外部配置')
    .option("-v, --verbose", "show thinking output and HTTP debug logs", false);
}

function toReplFlags(opts: Record<string, unknown>): CliFlags {
  return {
    profile: opts.profile as string | undefined,
    resume: opts.resume === true ? true : (opts.resume as string | undefined),
    server: opts.server === true,
    config: opts.config as string | undefined,
    verbose: !!(opts.verbose || process.env.DOCTOR_DEBUG),
  };
}

// 采集命令是顶层短命令（doctor mem / doctor trace / doctor log，对齐 perf record 一类手感）；
// 选项多，抽成 withXxxOptions 保持 main() 里只剩路由结构。
function withK8sProcessTargetOptions(cmd: CommandT): CommandT {
  return (
    cmd
      .option("-p, --pod <pod>", "目标 pod 名或关键词（缺省时列出候选）")
      .option("-c, --container <name>", "多容器 pod 时指定容器")
      .option("--pid <pid>", "目标进程 pid（缺省从 procscan 自动选）")
      .option(
        "--mode <mode>",
        "影响等级：observe、overhead 或 disrupt（缺省时交互选择；关键写操作需 [y/N] 确认）",
      )
  )
    .option("--profile <name>", "从 ~/.doctor/config.yaml 的该 profile 取 kubeconfig（--kubeconfig 优先）");
}

function withMemOptions(cmd: CommandT): CommandT {
  return (
    cmd
      .option("-p, --pod <pod>", "目标 pod 名或关键词（缺省时列出候选）")
      .option("-c, --container <name>", "多容器 pod 时指定容器")
      .option("--pid <pid>", "目标进程 pid（缺省从 procscan 自动选）")
      .option("--detail <detail>", "heap 内容：lite（精简）或 full（完整）", "lite")
      .option("--str-repr-len <n>", "覆盖策略中的对象字符串表示长度；-1 不采集")
      .option(
        "--capture-via <strategy>",
        "attach 路径：auto、debug-container 或 target-container",
        "auto",
      )
      .option("--transfer-chunk-size <size>", "回传分块大小：1m、2m 或 4m", "2m")
      .option("--cleanup-remote", "heap 成功回传后删除执行容器内临时文件", false)
  )
    .option("--profile <name>", "从 ~/.doctor/config.yaml 的该 profile 取 kubeconfig（--kubeconfig 优先）")
    .option("-o, --output <path>", "本机 heap 输出路径（默认 ./doctor-mem-<pod>-pid<pid>-<时间戳>.pyheap）");
}

function withMemaOptions(cmd: CommandT): CommandT {
  return cmd
    .option("-o, --output <path>", "HTML 分析报告输出路径");
}

function withCpuOptions(cmd: CommandT): CommandT {
  return withK8sProcessTargetOptions(cmd)
    .option("-o, --output <path>", "CPU 证据包输出路径（默认 ./doctor-cpu-<pod>-<时间戳>.tar.gz）");
}

function withTraceOptions(cmd: CommandT): CommandT {
  return withBizIdInputs(cmd, "业务 ID；可重复传入，Plugin traceId capability 先解析为 trace_id")
    .option("--from <manifest>", "仅使用已下载的 manifest 证据，不访问 Kubernetes / OpenSearch")
    .option("--span <span-id>", "在线只采集指定 span；离线查看该 span 的完整证据")
    .option("--node <node-id>", "离线查看 node 及其关联 spans（需要 --from）")
    .option("--service <name>", "OpenSearch backend service 覆盖值")
    .option("--endpoint <url>", "Doctor Host 直连 OpenSearch 的地址；缺省也读 DOCTOR_OPENSEARCH_URL")
    .option("--host <url>", "--endpoint 的兼容别名（已弃用）")
    .option("--index <expr>", "索引表达式（默认 jaeger-span-*）")
    .option("--index-date <date>", "jaeger-span-YYYY-MM-DD 单日索引（--index 给了则忽略）")
    .option("--username <user>", "OpenSearch 用户名（缺省读 DOCTOR_OPENSEARCH_USERNAME）")
    .option("--password <pass>", "OpenSearch 密码（缺省读 DOCTOR_OPENSEARCH_PASSWORD）")
    .option("--page-size <n>", "分页拉取批大小", "1000")
    .addOption(deliveryFormatOption(["html", "bundle"]))
    .option("--profile <name>", "从 ~/.doctor/config.yaml 的该 profile 取 kubeconfig（--kubeconfig 优先）")
    .option("-o, --output <path>", "报告 basename/路径（未指定 format 时生成同名 .html 与 .tar.gz）");
}

function withStoreOptions(cmd: CommandT): CommandT {
  return cmd
    .option("--type <types>", "逗号分隔的 Store 类型：db、vdb、s3、redis；交互终端缺省时多选")
    .option("--service <name>", "提供 Store 配置的业务 Service；缺省时从 Catalog capability 选择")
    .option("--store <id>", "Service 声明多个同类 Store 时指定 capability ID")
    .option("-p, --pod <pod>", "读取 Store 运行时配置的 Service Pod")
    .option("-c, --container <name>", "多容器 Pod 中读取配置的 Container")
    .option("--backend-service <name>", "VDB backend Kubernetes Service 覆盖值")
    .option("--endpoint <url>", "VDB backend 的 Doctor Host 直连地址覆盖值")
    .option("--s3-prefix <prefix>", "S3 对象画像范围；缺省使用 Service 配置的 bucket prefix")
    .option("--s3-max-objects <n>", "S3 对象画像最多扫描的对象数", "100000")
    .option("--s3-scan-timeout <seconds>", "S3 对象画像总时间预算", "120")
    .option("--database <n>", "Redis 仅深度分析指定 database；未指定时交互选择，非交互分析所有有数据的 DB")
    .option("--quick", "Redis 只采拓扑、容量和运行状态，不扫描 key", false)
    .option("--keystats", "Redis 强制对所有 master 运行 keyStats 深度探测", false)
    .option("--max-keys <n>", "Redis 最多检查的 key 总数", String(REDIS_DEFAULTS.maxKeys))
    .option("--max-keys-per-second <n>", "Redis 每秒最多检查的 key 数", String(REDIS_DEFAULTS.maxKeysPerSecond))
    .option("--top <n>", "Redis 各类 TopN 条目数", String(REDIS_DEFAULTS.top))
    .option("--show-key-names", "Redis TopN 显示完整 key 名", REDIS_DEFAULTS.showKeyNames)
    .option("--no-show-key-names", "Redis TopN 隐藏完整 key 名并使用哈希摘要")
    .addOption(deliveryFormatOption(["bundle", "html", "md"]))
    .option("--profile <name>", "从 profile 取 namespace / kubeconfig")
    .option("-o, --output <path>", "输出 basename/路径（未指定 format 时生成同名 .html 与 .tar.gz）");
}

function withLogOptions(cmd: CommandT, defaultServices: string): CommandT {
  const defaultDescription = defaultServices || "当前 Plugin 声明的默认 Service";
  return withBizIdInputs(cmd, "可选业务 ID；提供时解析 trace_id，省略时按 Service / 时间范围采集；可重复传入")
    .option(
      "--services <names>",
      `逗号分隔的 Kubernetes Service；缺省时交互多选，非交互默认 ${defaultDescription}`,
    )
    .option("--since <duration>", "kubectl 日志回看窗口（缺省时优先从 UUIDv7 ID 推导，否则为 6h）")
    .option("--since-time <timestamp>", "从指定时间开始，优先于 --since")
    .option("--until-time <timestamp>", "日志截止时间（RFC3339，包含边界）；无业务 ID 时默认命令开始时刻，读过终点即停止")
    .option("--errors-only", "只保留常见错误日志（有业务 ID 时先按 trace 过滤）", false)
    .option("--pattern <regex>", "按正则筛选日志（有业务 ID 时先按 trace 过滤）")
    .addOption(deliveryFormatOption(["html", "bundle"]))
    .option("--profile <name>", "从 ~/.doctor/config.yaml 的该 profile 取 kubeconfig（--kubeconfig 优先）")
    .option("-o, --output <path>", "报告 basename/路径（未指定 format 时生成同名 .html 与 .tar.gz）");
}

function withDataOptions(cmd: CommandT, defaultServiceNames: readonly string[]): CommandT {
  const defaultDescription = defaultServiceNames.length
    ? defaultServiceNames.join(",")
    : "当前 Plugin 中提供 Inspect contribution 的 Service";
  return withBizIdInputs(cmd, "需要汇集关联数据的业务 ID；可重复传入")
    .option(
      "--services <names>",
      `逗号分隔、提供 Inspect contribution 的 Service；缺省交互选择，非交互默认 ${defaultDescription}`,
    )
    .addOption(deliveryFormatOption(["bundle", "json", "html"]))
    .option("--profile <name>", "从 profile 取 kubeconfig；数据源身份仅作服务运行时配置的兜底")
    .option(
      "-o, --output <path>",
      "报告 basename/路径（未指定 format 时生成同名 .html 与 .tar.gz）",
    );
}

function withCollectOptions(cmd: CommandT): CommandT {
  return withBizIdInputs(cmd, "需要联合采集的业务 ID；可重复传入")
    .option("--include <kinds>", "要编排的命令：inspect、tenant、data、trace、log、metric；逗号分隔，交互模式缺省时多选")
    .option("--tenant-id <id>", "传给 doctor tenant 的租户 ID")
    .option("--tenant-name <name>", "传给 doctor tenant 的租户名")
    .option("--deployment-config", "传给 inspect：采集 Deployment Env/ConfigMap")
    .option("--no-deployment-config", "不采集 Deployment Env/ConfigMap")
    .option("--dependencies", "传给 inspect：采集应用依赖及版本")
    .option("--no-dependencies", "不采集应用依赖及版本")
    .option("--since <duration>", "传给 doctor log 的日志回看窗口")
    .option("--since-time <timestamp>", "传给 doctor log 的日志起始时间，优先于 --since")
    .option("--until-time <timestamp>", "传给 doctor log 的日志截止时间（RFC3339，包含边界）")
    .option("--watch <duration>", "传给 doctor metric 的采集窗口；默认 0")
    .option("--interval <duration>", "传给 doctor metric 的抓取间隔；默认 5s")
    .option("--prometheus <url>", "传给 doctor metric 的 Prometheus 地址")
    .addOption(deliveryFormatOption(["html", "bundle"]))
    .option("--profile <name>", "从 profile 取 namespace / kubeconfig / Prometheus")
    .option("-o, --output <path>", "集合报告 basename/路径（未指定 format 时生成同名 .html 与 .tar.gz）");
}

function withInspectOptions(cmd: CommandT): CommandT {
  return cmd
    .option("--services <names>", "逗号分隔的 Kubernetes Service；缺省时交互多选，非交互必须指定")
    .option("--deployment-config", "采集 Deployment Env/ConfigMap；交互模式未指定时询问，-y 默认不采集")
    .option("--no-deployment-config", "不采集 Deployment Env/ConfigMap")
    .option("--dependencies", "进入业务 Container 采集应用依赖；交互模式未指定时询问，-y 默认不采集")
    .option("--no-dependencies", "不采集应用依赖")
    .addOption(deliveryFormatOption(["bundle", "json", "html", "md"]))
    .option("--profile <name>", "从 profile 取 namespace / kubeconfig")
    .option("-o, --output <path>", "报告 basename/路径（未指定 format 时生成同名 .html 与 .tar.gz）");
}

function withTenantOptions(cmd: CommandT): CommandT {
  return cmd
    .option("--tenant-id <id>", "租户 ID；交互终端缺省时从租户目录中选择")
    .option("--tenant-name <name>", "通过租户目录精确解析租户名")
    .option("--tenant-directory-service <name>", "租户目录 Kubernetes Service；缺省由 Plugin 声明")
    .option("--tenant-directory-port <port>", "租户目录 Service HTTP 端口；缺省由 Plugin 声明")
    .option("--profile <name>", "从 profile 取 namespace / kubeconfig")
    .addOption(deliveryFormatOption(["bundle", "json", "html"]))
    .option("-o, --output <path>", "报告 basename/路径（未指定 format 时生成同名 .html 与 .tar.gz）");
}

function withHttpOptions(cmd: CommandT): CommandT {
  return cmd
    .option("--location <local|pod>", "请求执行位置；交互终端缺省时选择，非交互默认 local")
    .option("-p, --pod <pod>", "Pod 名或关键词；指定后自动使用 pod 执行位置")
    .option("-c, --container <name>", "Pod 内执行 HTTP 请求的 Container")
    .option("--file <path>", "doctor-http/v1 YAML 请求场景文件；交互终端缺省时从当前目录选择")
    .option("-e, --example [path]", "生成 doctor-http/v1 示例文件（默认 ./example.yaml）")
    .option("--request <ids>", "逗号分隔的 request id；交互终端缺省时选择，非交互执行全部")
    .option("--repeat <n>", "整个请求列表执行轮数", "1")
    .option("--interval <seconds>", "每轮之间的等待时间", "0")
    .option("--timeout <seconds>", "覆盖文件中的单请求超时")
    .option("--inspect-timeout <seconds>", "每个 URL host:port 的 DNS/TCP Inspect 超时", "3")
    .option("--max-size <mib>", "覆盖文件中的单响应最大采集容量")
    .addOption(deliveryFormatOption(["bundle", "html", "md"]))
    .option("--profile <name>", "Pod 执行位置从 profile 取 namespace / kubeconfig")
    .option("-o, --output <path>", "报告 basename/路径（未指定 format 时生成同名 .html 与 .tar.gz）");
}

function withNetworkOptions(cmd: CommandT): CommandT {
  return cmd
    .option("--file <path>", "doctor-http/v1 YAML 场景文件；选择后进入跟踪模式，不选择则进入守候模式")
    .option("--services <names>", "逗号分隔的 Kubernetes Service；交互终端缺省时多选，非交互必须指定")
    .option("--timeout <seconds>", "跟踪请求或守候窗口的最长时间", String(NETWORK_DEFAULTS.timeoutSeconds))
    .option("--drain <seconds>", "请求结束后继续抓包的时间", String(NETWORK_DEFAULTS.drainSeconds))
    .option("--max-pcap-size <mib>", "每个 Pod 的 PCAP 最大容量", String(NETWORK_DEFAULTS.maxPcapMiB))
    .option("--max-response-size <mib>", "响应体最大采集容量", String(NETWORK_DEFAULTS.maxResponseMiB))
    .option("--filter <bpf>", "覆盖按 Service 端口生成的 tcpdump BPF 粗过滤条件")
    .option("--cleanup-remote", "PCAP 成功回传并校验后清理 Pod 内本次抓包", false)
    .option("--profile <name>", "从 profile 取 namespace / kubeconfig")
    .option("-o, --output <path>", "NetBundle 输出路径（默认 ./doctor-net-<时间戳>.tar.gz）");
}

function withMcpOptions(cmd: CommandT): CommandT {
  return (
    cmd
      .option("--server <name>", "MCP server：server name 或 tenant/server；缺省时交互选择")
      .option("--tool <name>", "MCP tool name；缺省时交互选择")
      .option("--args <json>", "tool arguments JSON object")
      .option("--args-file <path>", "从文件读取 tool arguments JSON object")
      .option("--timeout <seconds>", "单步请求超时（1..600 秒）", "60")
      .option("--gateway-service <name>", "提供 MCP capability 的 Kubernetes Service；缺省由 Plugin Catalog 唯一推断")
  )
    .option("--profile <name>", "从 profile 取 namespace / kubeconfig")
    .addOption(deliveryFormatOption(["bundle", "html"]))
    .option(
      "-o, --output <path>",
      "输出 basename/路径（未指定 format 时生成同名 .html 与 .tar.gz）",
    );
}

function withModelOptions(cmd: CommandT): CommandT {
  return cmd
    .option("--tenant-id <id>", "租户 ID；交互终端缺省时从租户目录中选择")
    .option("--tenant-name <name>", "通过租户目录精确解析租户名")
    .option("--model <id|name>", "模型 ID 或名称；交互终端缺省时从模型目录中选择")
    .option("--type <type>", "只列出指定类型：llm、embedding、rerank 或 audio")
    .option("--timeout <seconds>", "模型 validation/inference 请求超时（1..600 秒）", "60")
    .option("--performance", "执行 LLM 流式性能测试；交互终端缺省时在 validation 后询问")
    .option("--no-performance", "跳过 LLM 流式性能测试")
    .option("--repeat <n>", "每个性能测试场景的采样次数（1..20）", "3")
    .option("--max-output-tokens <n>", "持续生成场景的最大输出 token（32..4096）", "256")
    .option("--model-catalog-service <name>", "模型目录 Kubernetes Service；缺省由 Plugin 声明")
    .option("--model-catalog-port <port>", "模型目录 Service HTTP 端口；缺省由 Plugin 声明")
    .option("--tenant-directory-service <name>", "租户目录 Kubernetes Service；缺省由 Plugin 声明")
    .option("--tenant-directory-port <port>", "租户目录 Service HTTP 端口；缺省由 Plugin 声明")
    .option("--profile <name>", "从 profile 取 namespace / kubeconfig")
    .addOption(deliveryFormatOption(["bundle", "json", "html"]))
    .option(
      "-o, --output <path>",
      "输出 basename/路径（未指定 format 时生成同名 .html 与 .tar.gz）",
    );
}

function withMetricOptions(cmd: CommandT): CommandT {
  return cmd
    .option("--services <names>", "逗号分隔的 metric provider；缺省时交互多选，非交互使用全部已注册 Service")
    .option("--watch <duration>", "采集窗口：0、1m、2m、5m、10m 或 until-interrupt；非交互默认 0")
    .option("--interval <duration>", "内嵌 Prombed 抓取间隔（500ms..60s）", "5s")
    .option("--prometheus <url>", "Prometheus 地址；优先于 profile.prometheus.url")
    .addOption(deliveryFormatOption(["html", "bundle"]))
    .option("--profile <name>", "从 profile 取 Prometheus 或 namespace / kubeconfig")
    .option("-o, --output <path>", "报告 basename/路径（未指定 format 时生成同名 .html 与 .tar.gz）");
}

function withPerfOptions(cmd: CommandT): CommandT {
  return cmd
    .option("--service <name>", "提供 perf capability 的 Service；仅一个 provider 时自动选择")
    .option("--scenario <id>", "Plugin 声明的业务压测场景；默认第一个")
    .option("--levels <numbers>", "逗号分隔的并发档位（最大 50；指定后跳过最高并发询问）")
    .option("--ramp <seconds>", "每档升压时间（秒）", "10")
    .option("--hold <seconds>", "每档稳态时间（秒）", "60")
    .option("--max-requests <n>", "每档最多产生的业务请求数", "100")
    .option("--abort-error-rate <ratio>", "当前档错误率熔断阈值 (0,1]", "0.1")
    .option("--breaker-min-n <n>", "启用错误率熔断前的最少请求数", "10")
    .option("--graceful-stop <seconds>", "停止发压后等待在途请求的时间", "60")
    .option("--request-timeout <seconds>", "单请求超时", "180")
    .option("--trace-samples <n>", "压测后采集的代表 trace/log 数量", "10")
    .option("--interval <duration>", "内嵌 Prombed 的 metric 抓取间隔", "5s")
    .option("--prometheus <url>", "Prometheus 地址；缺省使用内嵌 Prombed")
    .option("--profile <name>", "从 profile 取 namespace / kubeconfig / Plugin config")
    .addOption(deliveryFormatOption(["html", "bundle"], "--format <format>"))
    .option("-o, --output <path>", "HTML 产物目录或 Bundle 路径（默认 ./doctor-perf-<时间戳>）");
}

function withEvalOptions(cmd: CommandT): CommandT {
  return cmd
    .option("--service <name>", "提供 case capability 的 Service；仅一个 provider 时自动选择")
    .option("--caseset <id>", "要执行的 canonical CaseSet；仅一个 CaseSet 时自动选择")
    .option("--cases <ids>", "逗号分隔的 Case ID；缺省执行 CaseSet 中全部 Case，每个执行一次")
    .option("--request-timeout <seconds>", "单个 Case 请求超时", "180")
    .option("--profile <name>", "从 profile 取 namespace / kubeconfig / Plugin config")
    .addOption(deliveryFormatOption(["html", "bundle"], "--format <format>"))
    .option("-o, --output <path>", "报告 basename/路径（未指定 format 时生成同名 .html 与 .tar.gz）");
}

/** @spec Release inspection reads local composition only, never a diagnostic target. */
async function showVersion(distribution: Distribution): Promise<void> {
  const activePlugin = distribution.plugin ?? await loadActivePlugin();
  terminalStdout.info(`${formatDoctorVersion(activePlugin, getDoctorHostInfo(), distribution)}\n`);
}

/** Build the CLI surface without loading a profile or contacting a target. */
export function createDoctorProgram(
  distribution: Distribution = {},
): Command {
  const { plugin } = distribution;
  const program = new CliCommand();
  program
    .name(distribution.name ?? "doctor")
    .description(distribution.description ?? [
      "面向应用与基础设施的本地诊断工具。",
      "Core 提供通用 Target 访问与证据编排，Plugin 提供业务目标和数据语义；默认旁路运行、证据优先。",
    ].join("\n"))
    .option("-V, --version", "显示发行版名称与版本（离线）")
    .option("--debug", "错误时将完整技术详情同时输出到 stderr", false)
    .option("-y, --yes", "不询问，使用已解析的参数和默认值并确认所选操作；缺少必要参数时报错", false)
    .option("--no-yes", "关闭自动确认，允许交互终端补齐参数")
    .option("--config <path>", 'Doctor 配置路径（默认 ~/.doctor/config.yaml；空字符串禁用外部配置）')
    .option("-n, --namespace <ns>", "目标 namespace（业务采集为业务 Service 所在 namespace，默认 default）")
    .option("--kubeconfig <path>", "Kubernetes 配置路径，优先于 profile；仅访问 Kubernetes 时使用")
    .option("--context <name>", "Kubernetes context；未指定时使用 kubeconfig 当前 context")
    .configureHelp({ showGlobalOptions: true })
    .action(() => {
      // A root action handles global-only invocations, but must not swallow unknown commands.
      if (program.args.length) program.error(`unknown command '${program.args[0]}'`, { code: "commander.unknownCommand" });
      program.outputHelp();
    })
    .hook("preAction", () => {
      if (!program.opts().version) return;
      // A version flag must not load the Plugin or enter a diagnostic command's action.
      terminalStdout.info(`${formatDistributionVersion(distribution)}\n`);
      throw new CommanderError(0, "doctor.versionDisplayed", "");
    });

  const catalog = new CliCommand().copyInheritedSettings(program);

  withReplOptions(
    catalog.command("chat").description("交互式 AI 问诊（默认本地；--server 显式连接 profile 中的 doctor-server）"),
  ).action(async (opts, command: CommandT) => {
    opts = commandOptionsWithSources(command);
    const flags = toReplFlags(opts);
    await runCommand(chatCommand, { ...opts, ...flags }, domainInput(flags), { plugin });
  });

  catalog
    .command("init")
    .description("首次初始化 local profile")
    .option("-c, --config <path>", 'Doctor 配置路径；空字符串禁用外部配置')
    .action(async (opts, command: CommandT) => {
      opts = commandOptionsWithSources(command);
      await runStandaloneCommand("doctor init", () => runInit(opts));
    });

  catalog
    .command("profile [name]")
    .description("交互选择 profile，或指定名称并持久为默认 profile")
    .option("-c, --config <path>", 'Doctor 配置路径；空字符串禁用外部配置')
    .action(async (name, opts, command: CommandT) => {
      opts = commandOptionsWithSources(command);
      await runStandaloneCommand("doctor profile", () => runProfile(name, opts));
    });

  catalog
    .command("version")
    .description("显示发行版、Doctor Core、Plugin 与本机信息（离线）")
    .action(() => showVersion(distribution));

  const pluginCommand = catalog.command("plugin");
  registerPluginInfo(pluginCommand, plugin);
  pluginCommand
    .command("install <archive>")
    .description("安装并加载 Plugin 归档")
    .action(runPluginInstall);
  pluginCommand
    .command("uninstall <ref>")
    .description("卸载精确 plugin@version")
    .action(runPluginUninstall);

  catalog
    .command("help")
    .description("显示帮助信息")
    .action(() => {
      program.outputHelp();
    });

  catalog
    .command("image [image]")
    .description("将 image tar 发布到 Target Registry 和/或 load 到 Doctor Host")
    .option(
      "--tar <path>",
      "image tar 路径；可重复指定 amd64/arm64，缺省时从当前目录选择",
      (path, paths: string[] = []) => [...paths, path],
    )
    .option("--source-image <image>", "tar 包含多个 image 时指定要发布的源 image")
    .option("--registry", "发布到 Target Registry")
    .option("--host", "load 到 Doctor Host")
    .option("--profile <name>", "从 profile 取 kubeconfig 和 registry 凭据")
    .action(async (image, opts, command: CommandT) => {
      opts = commandOptionsWithSources(command);
      await runCommand(imageCommand, opts, { ...domainInput(opts), image }, { plugin });
    });

  catalog
    .command("debug")
    .allowExcessArguments(false)
    .description("为目标 Pod 启动或复用具备 ptrace 权限的 debug 临时容器")
    .option("-p, --pod <pod>", "单个目标 Pod 名或关键词；交互终端缺省时多选")
    .option("--services <names>", "逗号分隔的 Service；为其全部 Running Pod 准备 debug container")
    .option("-c, --container <name>", "目标业务容器")
    .option("--image <image>", "已发布且集群可拉取的 debug image")
    .option(
      "--capabilities <names>",
      "逗号分隔的显式权限：SYS_PTRACE、NET_RAW",
    )
    .option("--profile <name>", "从 profile 取 namespace、kubeconfig 或 kube.debug_image")
    .action(async (opts, command: CommandT) => {
      opts = commandOptionsWithSources(command);
      await runCommand(debugCommand, opts, domainInput(opts), { plugin });
    });

  catalog
    .command("install")
    .allowExcessArguments(false)
    .description("向目标 Pod container 安装排查程序；首版支持 GDB")
    .option("-p, --pod <pod>", "目标 Pod 名或关键词")
    .option("-c, --container <name>", "要安装 GDB 的目标 container")
    .option("--program <name>", "非交互调用指定要安装的程序；首版仅支持 gdb")
    .option("--tar <path>", "指定与 Target 平台和 kernel 兼容的 doctor-packages/v1 离线 tar")
    .option("-f, --format <format>", "输出 GDB 兼容性报告：md 或 json")
    .option("-o, --output <path>", "兼容性报告路径；未指定 --format 时按 .json 后缀推断，否则使用 md")
    .option("--profile <name>", "从 profile 取 namespace 和 kubeconfig")
    .action(async (opts, command: CommandT) => {
      opts = commandOptionsWithSources(command);
      await runCommand(installCommand, opts, { ...domainInput(opts), format: opts.format }, { plugin });
    });

  withMemOptions(
    catalog.command("mem").description("使用 fork-pyheap attach Python 进程并回传对象堆"),
  ).action(async (opts, command: CommandT) => {
    opts = commandOptionsWithSources(command);
    await runCommand(memCommand, opts, domainInput(opts), { plugin });
  });
  withMemaOptions(
    catalog.command("mema [inputs...]").description("在本机解析并诊断一个或多个 .pyheap 文件"),
  ).action(async (inputs, opts, command: CommandT) => {
    opts = commandOptionsWithSources(command);
    await runCommand(memaCommand, opts, { ...domainInput(opts), inputs }, { plugin });
  });
  withCpuOptions(
    catalog.command("cpu").description("对目标 pod 做 Python CPU/卡顿取证，产出证据包（无 server 直连）"),
  ).action(async (opts, command: CommandT) => {
    opts = commandOptionsWithSources(command);
    await runCommand(cpuCommand, opts, domainInput(opts), { plugin });
  });
  registerOverviewCommand(catalog, plugin);

  withCollectOptions(
    catalog.command("collect").description(
      "集合命令：选择、编排并汇总 inspect/tenant/data/trace/log/metric；本身不实现具体采集",
    ),
  ).action(async (
    positionalBizIds,
    opts: Omit<CollectCliOpts, "bizIds" | "kinds"> & { bizId?: string[]; include?: string },
    command: CommandT,
  ) => {
    opts = commandOptionsWithSources(command);
    const kinds = await resolveCollectKinds(opts.include);
    if (!kinds) {
      process.exitCode = 130;
      return;
    }
    const commandOpts = { ...normalizeBizIdOptions(positionalBizIds, opts), kinds };
    await runCommand(collectCommand, commandOpts, domainInput(commandOpts), { plugin });
  });
  withTraceOptions(
    catalog.command("trace").description("按业务 ID 采集 trace/span，或离线下钻证据；输出 manifest、HTML 或证据包"),
  ).action(async (positionalBizIds, opts: RawBizIdOptions<CollectTraceCliOpts>, command: CommandT) => {
    opts = commandOptionsWithSources(command);
    const commandOpts = normalizeBizIdOptions(positionalBizIds, opts);
    await runCommand(traceCommand, commandOpts, { ...domainInput(commandOpts), pageSize: commandOpts.pageSize === undefined ? undefined : Number(commandOpts.pageSize) }, { plugin });
  });
  withStoreOptions(
    catalog.command("store").description("从 Service Pod 提取配置并诊断 DB/VDB/S3/Redis 健康与容量（只读）"),
  ).action(async (opts, command: CommandT) => {
    opts = commandOptionsWithSources(command);
    await runCommand(storeCommand, opts, domainInput(opts), { plugin });
  });
  withDbOptions(catalog.command("db").description("发现 Service 可访问的数据库与表，执行有界只读 SQL"))
    .action(async (_opts, command: CommandT) => {
      const opts = commandOptionsWithSources(command);
      // SQL parsing belongs to db execution; help and unrelated commands do not load its grammar.
      const { dbCommand } = await import("../collect/db/command");
      await runCommand(dbCommand, opts, domainInput(opts), { plugin });
    });
  withLogOptions(
    catalog.command("log").description("按 Service / 时间范围采集 Pod 日志；可选业务 ID 关联 trace（只读）"),
    "",
  ).action(async (positionalBizIds, opts: RawBizIdOptions<CollectLogCliOpts>, command: CommandT) => {
    opts = commandOptionsWithSources(command);
    const commandOpts = normalizeBizIdOptions(positionalBizIds, opts);
    await runCommand(logCommand, commandOpts, domainInput(commandOpts), { plugin });
  });
  withDataOptions(
    catalog.command("data").description("先扩展业务 ID，再汇集 Service Catalog 声明的数据（由当前 Plugin 声明，只读）"),
    [],
  ).action(async (positionalBizIds, opts: RawBizIdOptions<CollectDataCliOpts>, command: CommandT) => {
    opts = commandOptionsWithSources(command);
    const commandOpts = normalizeBizIdOptions(positionalBizIds, opts);
    await runCommand(dataCommand, commandOpts, domainInput(commandOpts), { plugin });
  });
  withInspectOptions(
    catalog.command("inspect").description("检查 Service 的 workload、配置、Toolchain 与应用依赖（只读）"),
  ).action(async (opts, command: CommandT) => {
    opts = commandOptionsWithSources(command);
    await runCommand(inspectCommand, opts, domainInput(opts), { plugin });
  });
  withTenantOptions(
    catalog.command("tenant").description("汇总 Plugin 提供的租户粒度业务事实（只读）"),
  ).action(async (opts: CollectTenantCliOptions, command: CommandT) => {
    opts = commandOptionsWithSources(command);
    await runCommand(tenantCommand, opts, domainInput(opts), { plugin });
  });
  withHttpOptions(
    catalog.command("http").description("从 YAML 重放一个或多个 HTTP 请求，执行多轮诊断并产出 Bundle、HTML 或 Markdown"),
  ).action(async (opts: CollectHttpCliOpts, command: CommandT) => {
    opts = commandOptionsWithSources(command);
    await runCommand(httpCommand, opts, domainInput(opts), { plugin, printProfile: opts.example === undefined });
  });
  withNetworkOptions(
    catalog.command("net").description("协调目标服务 Pod 短时抓包，以跟踪或守候模式产出 NetBundle"),
  ).action(async (opts: CollectNetworkCliOpts, command: CommandT) => {
    opts = commandOptionsWithSources(command);
    await runCommand(netCommand, opts, domainInput(opts), { plugin });
  });
  catalog
    .command("neta [input]")
    .description("纯离线分析 NetBundle，重建业务调用并生成 Findings、Coverage 与可视化报告")
    .option("--trace-id <ids>", "逗号分隔的一个或多个 trace ID（缺省读取 NetBundle）")
    .option("--capture-id <id>", "覆盖 NetBundle 中的染色 ID")
    .option("-o, --output <path>", "报告输出路径或前缀；生成同名 Markdown、HTML 与 JSON")
    .action(async (input, opts, command: CommandT) => {
      opts = commandOptionsWithSources(command);
      await runStandaloneCommand("doctor neta", () => runAnalyzeNetwork(input, opts));
    });
  withMcpOptions(
    catalog.command("mcp").description("对 MCP tool 执行多维取证与规则分析，产出 Evidence Bundle 或 HTML"),
  ).action(async (opts, command: CommandT) => {
    opts = commandOptionsWithSources(command);
    await runCommand(mcpCommand, opts, domainInput(opts), { plugin });
  });
  withModelOptions(
    catalog.command("model").description("从模型目录选择可用模型，执行 validation 与真实 inference"),
  ).action(async (opts, command: CommandT) => {
    opts = commandOptionsWithSources(command);
    await runCommand(modelCommand, opts, domainInput(opts), { plugin });
  });
  withMetricOptions(
    catalog.command("metric").description("采集 Service 声明的 Prometheus metrics，执行 detector 并生成离线 HTML 图表"),
  ).action(async (opts, command: CommandT) => {
    opts = commandOptionsWithSources(command);
    await runCommand(metricCommand, opts, domainInput(opts), { plugin });
  });
  withEvalOptions(
    catalog.command("eval").description("按 canonical CaseSet 触发真实请求并采集关联 trace、log、data，不做质量评分"),
  ).action(async (opts, command: CommandT) => {
    opts = commandOptionsWithSources(command);
    await runCommand(evalCommand, opts, domainInput(opts), { plugin });
  });
  withPerfOptions(
    catalog.command("perf").description("发起受控业务压测，并在同一窗口交付 metric、trace 与 log 证据"),
  ).action(async (opts, command: CommandT) => {
    opts = commandOptionsWithSources(command);
    await runCommand(perfCommand, opts, domainInput(opts), { plugin });
  });

  const visibleCommands = new Set(selectVisibleCommands(catalog.commands, distribution.commands ?? DOCTOR_COMMANDS));
  for (const command of catalog.commands) {
    program.addCommand(command, { hidden: !visibleCommands.has(command) });
  }
  applyOptionDefaults(program, distribution.optionDefaults);
  applyCommandDefaults(program, distribution.commandDefaults);
  configureProfileHelp(program);
  return program;
}

export async function main(distribution: Distribution = {}) {
  const program = createDoctorProgram(distribution);

  if (process.argv.length === 2) {
    program.outputHelp();
    return;
  }
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof CommanderError && error.code === "doctor.versionDisplayed") return;
    throw error;
  }
}

export function startDoctor(distribution: Distribution = {}): void {
  const { plugin } = distribution;
  const pluginIdentity = plugin ? `${plugin.id}@${plugin.version}` : undefined;
  process.once("uncaughtException", (error) => {
    reportError(error, {
      context: "doctor runtime/uncaughtException",
      summary: "fatal",
      plugin: pluginIdentity,
    });
    process.exit(1);
  });
  process.once("unhandledRejection", (reason) => {
    reportError(reason, {
      context: "doctor runtime/unhandledRejection",
      summary: "fatal",
      plugin: pluginIdentity,
    });
    process.exit(1);
  });
  main(distribution).catch((err) => {
    reportError(err, {
      context: "doctor main",
      summary: "fatal",
      displayMessage: mapErrorMessage(err),
      plugin: pluginIdentity,
    });
    process.exit(1);
  });
}
