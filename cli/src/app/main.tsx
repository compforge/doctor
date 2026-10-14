#!/usr/bin/env bun
import { serviceOption } from "./service-option";
import { isRemoteChat } from "./config/state";
import { withLogger } from "../terminal/log";
import { commandOptionsWithSources } from "./option-sources";
import type { CollectHttpCliOpts } from "../collect/http";
import type { CollectNetworkCliOpts } from "../collect/network";
import { writeOutput } from "../terminal/output";
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
//   doctor case              → 列出 Case，多选后通过 HTTP 发送并分析响应（collect/）
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
import { Command, CommanderError, Option, type Command as CommandT } from "commander";
import { CliCommand } from "./cli-command";
import { extractDistributionArgument, loadDistributionManifest, type Distribution, type DoctorHostOptions } from "./distribution";
import { applyCommandDefaults, configureDeliveryHelp, deliveryFormatOption } from "./command-defaults";
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
import { registerHealthCommand } from "../health/command";
import { registerSampleCommand } from "../overview/command";
import type { CliFlags } from "../protocol";
import { reportError } from "./error-report";
import { runInit } from "./init";
import { runProfile } from "./profile";
import { configureProfileHelp } from "./profile-help";
import { applyOptionDefaults } from "./command-defaults";
import { loadActivePlugin, loadInstalledPlugin } from "../plugin";
import { registerPluginInfo, runPluginInstall, runPluginUninstall } from "./plugin";
import { registerKnowledgeCommand } from "../knowledge/command";
import { runCommand, runStandaloneCommand } from "./command";
import { normalizeBizIdOptions, withBizIdInputs } from "./biz-id-input";
import { getDoctorHostInfo } from "../infra/host";

import { domainInput } from "../command/options";
import { chatCommand, imageCommand, debugCommand, installCommand, memCommand, memaCommand, cpuCommand, caseCommand, netCommand } from "./core-commands";
import { traceCommand } from "../collect/trace/command";
import { logCommand } from "../collect/log/command";
import { dataCommand } from "../collect/data/command";
import { inspectCommand } from "../collect/inspect/command";
import { tenantCommand } from "../collect/tenant/command";
import { metricCommand } from "../collect/metric/command";
import { storeCommand } from "../collect/store/command";
import { withDbOptions } from "../collect/db/options";
import { withS3Options } from "../collect/s3/options";
import { mcpCommand } from "../collect/mcp/command";
import { modelCommand } from "../collect/model/command";
import { collectCommand } from "../collect/composite";
import { evalCommand } from "../eval/command";
import { perfCommand } from "../perf/command";
import { doctorCaseCatalog, selectDoctorCases } from "../case/catalog";
import { isInteractive, withInteractionOptions } from "../terminal/policy";
import { promptListedChoice } from "../terminal/selection";

type RawBizIdOptions<T> = Omit<T, "bizIds" | "bizId"> & { bizId?: string[] };

// REPL 选项只属于 chat 子命令，root 保持为中性的能力索引。
function withReplOptions(cmd: CommandT): CommandT {
  return cmd
    .option("-p, --profile <name>", "profile name from ~/.doctor/config.yaml")
    .option("--server", "use the doctor-server configured by the profile", false)
    .option("-c, --continue", "继续当前目录最近的本地会话")
    .option("-r, --resume [id]", "选择本地历史会话；--server 时恢复远端会话")
    .option("--session <path-or-id>", "恢复指定本地 JSONL 会话文件或 ID")
    .option("--session-dir <dir>", "本地会话根目录（默认 ~/.doctor/sessions）")
    .option("--no-session", "不保存本地聊天")
    .option("--config <path>", 'Doctor 配置路径；空字符串禁用外部配置');
}

function toReplFlags(opts: Record<string, unknown>): CliFlags {
  return {
    profile: opts.profile as string | undefined,
    namespace: opts.namespace as string | undefined,
    resume: opts.resume === true ? true : (opts.resume as string | undefined),
    server: opts.server === true,
    continue: opts.continue === true,
    session: typeof opts.session === "string" ? opts.session : undefined,
    noSession: opts.session === false,
    sessionDir: opts.sessionDir as string | undefined,
    config: opts.config as string | undefined,
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
  return withBizIdInputs(cmd, "业务 ID 或 trace ID；可重复传入，Plugin trace.resolve 解析为规范 trace_id")
    .option("--since <duration>", "按时间范围解析 trace ID，例如 1h、30m、2d")
    .option("--since-time <timestamp>", "时间范围起点（RFC3339；优先于 --since）")
    .option("--until-time <timestamp>", "时间范围终点（RFC3339；缺省为本次命令开始时刻）")
    .option("--limit <n>", "传给 trace.range 的目标上限（默认 50；Plugin 可按候选记录限量）")
    .option("--concurrency <n>", "同时采集的 trace 数（默认 2）")
    .option("--from <manifest>", "仅使用已下载的 manifest 证据，不访问 Kubernetes / OpenSearch")
    .option("--trace-file <path>", "导入单条 Jaeger trace JSON/JSONL，离线投影并生成报告")
    .option("--span <span-id>", "在线只采集指定 span；离线查看该 span 的完整证据")
    .option("--node <node-id>", "离线查看 node 及其关联 spans（需要 --from）")
    .addOption(new Option("--view <view>", "trace: default/agent；node: default/measurements/timeline")
      .choices(["default", "agent", "measurements", "timeline"]))
    .option("--endpoint <url>", "Doctor Host 直连 OpenSearch 的地址；缺省也读 DOCTOR_OPENSEARCH_URL")
    .option("--host <url>", "--endpoint 的兼容别名（已弃用）")
    .option("--index <expr>", "索引表达式（默认 jaeger-span-*）")
    .option("--index-date <date>", "jaeger-span-YYYY-MM-DD 单日索引（--index 给了则忽略）")
    .option("--username <user>", "OpenSearch 用户名（缺省读 DOCTOR_OPENSEARCH_USERNAME）")
    .option("--password <pass>", "OpenSearch 密码（缺省读 DOCTOR_OPENSEARCH_PASSWORD）")
    .option("--page-size <n>", "分页拉取批大小", "1000")
    .addOption(deliveryFormatOption(["html", "bundle", "text", "json"]))
    .option("--profile <name>", "从 ~/.doctor/config.yaml 的该 profile 取 kubeconfig（--kubeconfig 优先）")
    .option("-o, --output <path>", "报告 basename/路径（未指定 format 时生成同名 .html 与 .tar.gz）");
}

function withStoreOptions(cmd: CommandT): CommandT {
  return cmd
    .option("--type <types>", "逗号分隔的 Store 类型：db、vdb、s3、redis；交互终端缺省时多选")
    .addOption(serviceOption("提供 Store 配置的业务 Service；缺省时从 Catalog capability 选择"))
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
  return withBizIdInputs(cmd, "可选业务 ID；提供时解析 trace 或已声明的关联对象，省略时按 Service / 时间范围采集；可重复传入")
    .addOption(serviceOption(`Kubernetes Service；缺省时交互多选，非交互默认 ${defaultDescription}`))
    .option("--since <duration>", "kubectl 日志回看窗口（缺省时优先从 UUIDv7 ID 推导，否则为 6h）")
    .option("--since-time <timestamp>", "从指定时间开始，优先于 --since")
    .option("--until-time <timestamp>", "日志截止时间（RFC3339，包含边界）；无业务 ID 时默认命令开始时刻，读过终点即停止")
    .option("--errors-only", "只保留常见错误日志（有业务 ID 时先按 trace 或关联对象过滤）", false)
    .option("--pattern <regex>", "按正则筛选日志（有业务 ID 时先按 trace 或关联对象过滤）")
    .addOption(deliveryFormatOption(["html", "bundle", "summary"]))
    .option("--profile <name>", "从 ~/.doctor/config.yaml 的该 profile 取 kubeconfig（--kubeconfig 优先）")
    .option("-o, --output <path>", "报告 basename/路径（未指定 format 时生成同名 .html 与 .tar.gz）");
}

function withDataOptions(cmd: CommandT, defaultServiceNames: readonly string[]): CommandT {
  const defaultDescription = defaultServiceNames.length
    ? defaultServiceNames.join(",")
    : "当前 Plugin 中提供 Inspect contribution 的 Service";
  return withBizIdInputs(cmd, "需要汇集关联数据的业务 ID；可重复传入")
    .addOption(serviceOption(`提供 Inspect contribution 的 Service；缺省交互选择，非交互默认 ${defaultDescription}`))
    .option("--since <duration>", "事件回看窗口，例如 30m、2h")
    .option("--since-time <timestamp>", "事件起点（RFC3339；优先于 --since）")
    .option("--until-time <timestamp>", "事件终点（RFC3339，包含边界；指定窗口时缺省为命令开始时刻）")
    .addOption(deliveryFormatOption(["bundle", "json", "html", "summary"]))
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
    .option("--since <duration>", "Log 与 Data/Inspect 事件的统一回看窗口")
    .option("--since-time <timestamp>", "Log 与 Data/Inspect 事件的统一起点，优先于 --since")
    .option("--until-time <timestamp>", "Log 与 Data/Inspect 事件的统一终点（RFC3339，包含边界）")
    .option("--watch <duration>", "传给 doctor metric 的采集窗口；默认 0")
    .option("--interval <duration>", "传给 doctor metric 的抓取间隔；默认 5s")
    .option("--prometheus <url>", "传给 doctor metric 的 Prometheus 地址")
    .addOption(deliveryFormatOption(["html", "bundle", "summary"]))
    .option("--profile <name>", "从 profile 取 namespace / kubeconfig / Prometheus")
    .option("-o, --output <path>", "集合报告 basename/路径（未指定 format 时生成同名 .html 与 .tar.gz）");
}

function withInspectOptions(cmd: CommandT): CommandT {
  return cmd
    .addOption(serviceOption("Kubernetes Service；缺省时交互多选，非交互必须指定"))
    .option("--deployment-config", "采集 Deployment Env/ConfigMap；交互模式未指定时询问，-y 默认不采集")
    .option("--no-deployment-config", "不采集 Deployment Env/ConfigMap")
    .option("--dependencies", "进入业务 Container 采集应用依赖；交互模式未指定时询问，-y 默认不采集")
    .option("--no-dependencies", "不采集应用依赖")
    .option("--since <duration>", "事件回看窗口，例如 30m、2h")
    .option("--since-time <timestamp>", "事件起点（RFC3339；优先于 --since）")
    .option("--until-time <timestamp>", "事件终点（RFC3339，包含边界；指定窗口时缺省为命令开始时刻）")
    .addOption(deliveryFormatOption(["bundle", "json", "html", "md", "summary"]))
    .option("--profile <name>", "从 profile 取 namespace / kubeconfig")
    .option("-o, --output <path>", "报告 basename/路径（未指定 format 时生成同名 .html 与 .tar.gz）");
}

function withTenantOptions(cmd: CommandT): CommandT {
  return cmd
    .option("--tenant-id <id>", "租户 ID；交互终端缺省时从租户目录中选择")
    .option("--tenant-name <name>", "通过租户目录精确解析租户名")
    .option("--directory-provider <service[/extension]>", "租户目录 Extension 提供方")
    .option("--tenant-directory-service <name>", "租户目录 Kubernetes Service；缺省由 Plugin 声明")
    .option("--tenant-directory-port <port>", "租户目录 Service HTTP 端口；缺省由 Plugin 声明")
    .option("--profile <name>", "从 profile 取 namespace / kubeconfig")
    .addOption(deliveryFormatOption(["bundle", "json", "html", "summary"]))
    .option("-o, --output <path>", "报告 basename/路径（未指定 format 时生成同名 .html 与 .tar.gz）");
}

function withCaseOptions(cmd: CommandT): CommandT {
  return cmd
    .option("--case-file <path>", "外部 CaseSet YAML；缺省读取当前目录 doctor-cases.yaml")
    .option("--caseset <id>", "要发送的 CaseSet")
    .option("--cases <ids>", "逗号分隔的 Case ID；交互时可多选")
    .option("--send", "发送选中的 HTTP Case；非交互环境必须显式指定", false)
    .option("--base-url <url>", "发送目标的 http(s) base URL；Case 只声明相对 path")
    .option("--location <local|pod>", "请求执行位置；交互终端缺省时选择，非交互默认 local")
    .option("-p, --pod <pod>", "Pod 名或关键词；指定后自动使用 pod 执行位置")
    .option("-c, --container <name>", "Pod 内执行 HTTP 请求的 Container")
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
    .addOption(serviceOption("Kubernetes Service；交互终端缺省时多选，非交互必须指定"))
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
    .option("--case-file <path>", "外部 CaseSet YAML；缺省读取当前目录 doctor-cases.yaml")
    .option("--caseset <id>", "选择 CaseSet")
    .option("--cases <ids>", "逗号分隔的 Case ID；交互时可多选")
    .option("--tenant-id <id>", "租户 ID；交互终端缺省时从租户目录中选择")
    .option("--tenant-name <name>", "通过租户目录精确解析租户名")
    .option("--model <id|name>", "模型 ID 或名称；交互终端缺省时从模型目录中选择")
    .option("--type <type>", "只列出指定类型：llm、embedding、rerank 或 audio")
    .option("--timeout <seconds>", "模型 validation/inference 请求超时（1..600 秒）", "60")
    .option("--performance", "默认选择四个内置 LLM 流式性能 Case；也可用 --cases 指定")
    .option("--no-performance", "显式禁止选择 LLM 流式性能 Case")
    .option("--repeat <n>", "每个性能测试场景的采样次数（1..20）", "3")
    .option("--max-output-tokens <n>", "持续生成场景的最大输出 token（32..4096）", "256")
    .option("--model-provider <service[/extension]>", "模型查询 Extension 提供方；多候选时必须选择")
    .option("--inference-provider <service[/extension]>", "模型推理 Extension 提供方")
    .option("--model-catalog-service <name>", "模型目录 Kubernetes Service；缺省由 Plugin 声明")
    .option("--model-catalog-port <port>", "模型目录 Service HTTP 端口；缺省由 Plugin 声明")
    .option("--directory-provider <service[/extension]>", "租户目录 Extension 提供方")
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
    .addOption(serviceOption("metric provider；缺省时交互多选，非交互使用全部已注册 Service"))
    .option("--watch <duration>", "采集窗口：0、1m、2m、5m、10m 或 until-interrupt；非交互默认 0")
    .option("--interval <duration>", "内嵌 Prombed 抓取间隔（500ms..60s）", "5s")
    .option("--prometheus <url>", "Prometheus 地址；优先于 profile.prometheus.url")
    .addOption(deliveryFormatOption(["html", "bundle"]))
    .option("--profile <name>", "从 profile 取 Prometheus 或 namespace / kubeconfig")
    .option("-o, --output <path>", "报告 basename/路径（未指定 format 时生成同名 .html 与 .tar.gz）");
}

function withPerfOptions(cmd: CommandT): CommandT {
  return cmd
    .option("--case-file <path>", "外部 CaseSet YAML；缺省读取当前目录 doctor-cases.yaml")
    .option("--caseset <id>", "选择 CaseSet")
    .option("--cases <ids>", "逗号分隔的 Case ID；交互时可多选")
    .addOption(serviceOption("提供 perf capability 的 Service；仅一个 provider 时自动选择"))
    .option("--scenario <id>", "Plugin 声明的压测观测配置；默认第一个")
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
    .addOption(serviceOption("提供 case capability 的 Service；仅一个 provider 时自动选择"))
    .option("--case-file <path>", "外部 CaseSet YAML；缺省读取当前目录 doctor-cases.yaml")
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
  writeOutput(`${formatDoctorVersion(activePlugin, getDoctorHostInfo(), distribution)}\n`);
}

/**
 * Build the CLI surface without loading a profile or contacting a target.
 * @spec A Distribution description replaces the complete root description, including diagnostic guidance.
 * @see {@link component://docs/distribution.md}
 */
export function createDoctorProgram(
  distribution: Distribution = {},
  host: DoctorHostOptions = {},
): Command {
  const { plugin } = distribution;
  const commandRuntime = { plugin, logLevel: distribution.logLevel };
  const program = new CliCommand();
  program
    .name(distribution.name ?? "doctor")
    .description(distribution.description ?? [
      "面向应用与基础设施的本地诊断工具；默认旁路运行、证据优先。",
      "",
      "诊断模型：",
      "  Core 提供通用 Target 访问与证据编排；Plugin 交付产品与 Service 的业务知识、诊断声明和 Skill。",
      "  Concepts（核心概念）解释业务对象与约束；Workflows（典型流程）说明从触发到完成的业务过程。",
      "  Service 是业务诊断对象，拥有零到多个 Workload；Pod、Container、Process 提供运行态证据。",
      "  Doctor Host 是运行 CLI 的机器，Target 是被诊断目标；访问位置会影响观测结果。",
      "  Facts / Observations 保存事实与观测，Findings 是基于已有证据的规则判断。",
      "",
      "排查路径：",
      "  理解产品与服务 → knowledge 查看概念 / 流程；--service <name> 聚焦服务",
      "  系统整体异常   → health 查看统计与体检 → sample 选取代表业务 ID → collect 汇集证据",
      "  已知异常请求   → collect 联合取证，或 trace / log / data 聚焦单个数据面",
      "  部署与依赖异常 → inspect 查看运行态与配置 → store 检查存储 → db / s3 查询具体数据",
      "  主动复现问题   → case / model / mcp；批量触发与取证用 eval，受控压测用 perf",
      "  CPU / 内存 / 网络 → cpu / mem / net 采集；对象堆与网络证据用 mema / neta 离线分析",
      "  已知错误码     → knowledge lookup <dictionary> 查询词条；开放式问题用 chat 组织调查",
      "",
      "证据原则：",
      "  先核对对象、执行位置、时间窗口和采集完整性，再区分观测事实、规则发现与待验证推断。",
      "  空结果、采集失败、未执行和正常结果含义不同；没有发现异常只能说明本次覆盖范围。",
      "  报告保留可复查证据；输出格式改变交付视图，具体采集范围由命令参数决定。",
      "  主动请求与 image / debug / install 等准备动作会影响目标，执行前核对动作与授权。",
    ].join("\n"))
    .option("-V, --version", "显示发行版名称与版本（离线）")
    .option("--debug", "错误时将完整技术详情同时输出到 stderr", false)
    .option("-y, --yes", "不询问，使用已解析的参数和默认值并确认所选操作；缺少必要参数时报错", false)
    .option("--no-yes", "关闭自动确认，允许交互终端补齐参数")
    .option("--config <path>", 'Doctor 配置路径（默认 ~/.doctor/config.yaml；空字符串禁用外部配置）')
    .option("--distribution <path>", "从 JSON 加载发行配置")
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
      writeOutput(`${formatDistributionVersion(distribution)}\n`);
      throw new CommanderError(0, "doctor.versionDisplayed", "");
    });

  const catalog = new CliCommand().copyInheritedSettings(program);

  withReplOptions(
    catalog.command("chat").description("交互式 AI 问诊（默认本地；--server 显式连接 profile 中的 doctor-server）")
      .addHelpText("after", `
分析思路：
  围绕问题选择工具并检查返回证据，使用当前 Plugin 随版本提供的业务 Skill。
结果解读：
  调查结论应关联实际工具结果；缺少证据的假设需要继续取证，不能当作已确认根因。
`),
  ).action(async (opts, command: CommandT) => {
    opts = commandOptionsWithSources(command);
    const flags = toReplFlags(opts);
    // Local session selection belongs to Chat, not the legacy remote profile resolver.
    const remoteResume = isRemoteChat(flags);
    await runCommand(chatCommand, { ...opts, ...flags, resume: remoteResume ? flags.resume : undefined }, {
      ...domainInput(flags), agentCommands: host.agentCommands,
    }, commandRuntime);
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

  registerKnowledgeCommand(catalog, plugin);

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
    .command("help [command]")
    .description("显示帮助信息")
    .action((name?: string) => {
      const target = name ? program.commands.find(command => command.name() === name || command.aliases().includes(name)) : program;
      if (!target) return program.error(`unknown command '${name}'`, { code: "commander.unknownCommand" });
      target.outputHelp();
    });

  catalog
    .command("image [image]").helpGroup("Provision · 能力准备:")
    .description("将 image tar 发布到 Target Registry 和/或 load 到 Doctor Host")
    .addHelpText("after", `
分析思路：
  把已有镜像包交付到 Target Registry 或 Doctor Host，为后续诊断准备资源。
结果解读：
  上传或 load 成功只证明镜像交付；目标 Pod 能否拉取、启动并使用该镜像仍需现场验证。
`)
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
      await runCommand(imageCommand, opts, { ...domainInput(opts), image }, commandRuntime);
    });

  catalog
    .command("debug").helpGroup("Provision · 能力准备:")
    .allowExcessArguments(false)
    .description("为目标 Pod 启动或复用具备 ptrace 权限的 debug 临时容器")
    .addHelpText("after", `
分析思路：
  为选定 Pod 准备诊断容器和所需权限，供后续 CPU、内存或网络取证使用。
结果解读：
  容器与权限准备成功只说明具备取证条件；实际进程或网络问题由后续采集判断。
`)
    .option("-p, --pod <pod>", "单个目标 Pod 名或关键词；交互终端缺省时多选")
    .addOption(serviceOption("Service；为其全部 Running Pod 准备 debug container"))
    .option("-c, --container <name>", "目标业务容器")
    .option("--image <image>", "已发布且集群可拉取的 debug image")
    .option(
      "--capabilities <names>",
      "逗号分隔的显式权限：SYS_PTRACE、NET_RAW",
    )
    .option("--profile <name>", "从 profile 取 namespace、kubeconfig 或 kube.debug_image")
    .action(async (opts, command: CommandT) => {
      opts = commandOptionsWithSources(command);
      await runCommand(debugCommand, opts, domainInput(opts), commandRuntime);
    });

  catalog
    .command("install").helpGroup("Provision · 能力准备:")
    .allowExcessArguments(false)
    .description("向目标 Pod container 安装排查程序；首版支持 GDB")
    .addHelpText("after", `
分析思路：
  按目标容器的 OS、架构与 kernel 选择兼容资源，并将诊断程序安装到指定容器。
结果解读：
  安装与兼容性结果只覆盖该目标容器；后续仍需运行相应诊断命令取得问题证据。
`)
    .option("-p, --pod <pod>", "目标 Pod 名或关键词")
    .option("-c, --container <name>", "要安装 GDB 的目标 container")
    .option("--program <name>", "非交互调用指定要安装的程序；首版仅支持 gdb")
    .option("--tar <path>", "指定与 Target 平台和 kernel 兼容的 doctor-packages/v1 离线 tar")
    .option("-f, --format <format>", "输出 GDB 兼容性报告：md 或 json")
    .option("-o, --output <path>", "兼容性报告路径；未指定 --format 时按 .json 后缀推断，否则使用 md")
    .option("--profile <name>", "从 profile 取 namespace 和 kubeconfig")
    .action(async (opts, command: CommandT) => {
      opts = commandOptionsWithSources(command);
      await runCommand(installCommand, opts, { ...domainInput(opts), format: opts.format }, commandRuntime);
    });

  withMemOptions(
    catalog.command("mem").helpGroup("Collect · 采集与分析:").description("使用 fork-pyheap attach Python 进程并回传对象堆")
      .addHelpText("after", `
分析思路：
  在线 attach 选定 Python 进程并导出对象堆，回传后交给 mema 离线分析。
结果解读：
  采集会增加目标开销，确认 attach 与内存余量计划后执行；单次堆快照不足以证明持续泄漏。
`),
  ).action(async (opts, command: CommandT) => {
    opts = commandOptionsWithSources(command);
    await runCommand(memCommand, opts, domainInput(opts), commandRuntime);
  });
  withMemaOptions(
    catalog.command("mema [inputs...]").helpGroup("Collect · 采集与分析:").description("在本机解析并诊断一个或多个 .pyheap 文件")
      .addHelpText("after", `
分析思路：
  在 Doctor Host 读取已有对象堆，分析对象占用与引用关系；多个快照可用于比较变化。
结果解读：
  大对象或一次增长是调查线索；判断泄漏需结合采集时刻、负载和持续增长证据。
`),
  ).action(async (inputs, opts, command: CommandT) => {
    opts = commandOptionsWithSources(command);
    await runCommand(memaCommand, opts, { ...domainInput(opts), inputs }, commandRuntime);
  });
  withCpuOptions(
    catalog.command("cpu").helpGroup("Collect · 采集与分析:").description("对目标 pod 做 Python CPU/卡顿取证，产出证据包（无 server 直连）")
      .addHelpText("after", `
分析思路：
  先检查容器资源、Python 进程与取证条件，再按所选模式取得线程栈证据。
结果解读：
  单次线程栈是时点快照；判断持续 CPU 热点或阻塞需结合多次观测、CPU 曲线与请求时延。
`),
  ).action(async (opts, command: CommandT) => {
    opts = commandOptionsWithSources(command);
    await runCommand(cpuCommand, opts, domainInput(opts), commandRuntime);
  });
  registerSampleCommand(catalog, commandRuntime);
  registerHealthCommand(catalog, commandRuntime);

  withCollectOptions(
    catalog.command("collect").helpGroup("Collect · 采集与分析:").description(
      "集合命令：选择、编排并汇总 inspect/tenant/data/trace/log/metric；本身不实现具体采集",
    )
      .addHelpText("after", `
分析思路：
  按所选数据面调用 inspect / tenant / data / trace / log / metric，并汇总各自证据。
结果解读：
  逐项检查成功、失败和缺口，汇总完成不代表每项完整；精确控制单个数据面时运行对应命令。
`),
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
    await runCommand(collectCommand, commandOpts, domainInput(commandOpts), commandRuntime);
  });
  withTraceOptions(
    catalog.command("trace").helpGroup("Collect · 采集与分析:").description("按 trace ID、业务 ID 或时间范围采集，也可导入 Jaeger 文件或离线下钻")
      .addHelpText("after", `
分析思路（Trace Harness）：
  trace/span 标准化为 Node，保留发生的事实与源 span 引用。
  Measurer 对 trace/node 计算客观 Measurement；Detector 可使用这些度量，按规则产出 Finding。
  View 按不同侧重点展示同一 trace/node 的已有数据，render 将其呈现为 text、JSON 或 HTML。
  采集后的证据可通过 --from 离线切换视图和格式，复用已保存的分析结果。
结果解读：
  空结果先检查 ID 解析、时间窗口与数据源；部分采集或单 span 证据不能代表完整调用链。
  Finding 是规则判断；调用耗时可能重叠，不能相加当成总耗时，也不能仅凭最长调用认定根因。
下一步：
  用 --format manifest 保存证据，再以 --from 配合 --node / --span 下钻已有内容。
`),
  ).action(async (positionalBizIds, opts: RawBizIdOptions<CollectTraceCliOpts>, command: CommandT) => {
    opts = commandOptionsWithSources(command);
    const commandOpts = normalizeBizIdOptions(positionalBizIds, opts);
    await runCommand(traceCommand, commandOpts, { ...domainInput(commandOpts),
      pageSize: commandOpts.pageSize === undefined ? undefined : Number(commandOpts.pageSize) }, commandRuntime);
  });
  withStoreOptions(
    catalog.command("store").helpGroup("Collect · 采集与分析:").description("从 Service Pod 提取配置并诊断 DB/VDB/S3/Redis 健康与容量（只读）")
      .addHelpText("after", `
分析思路：
  从 Service 提供的连接与访问上下文检查存储健康和容量，保留各后端的取证结果。
结果解读：
  有界扫描或抽样只覆盖实际检查范围；具体记录或对象问题可继续使用 db / s3。
`),
  ).action(async (opts, command: CommandT) => {
    opts = commandOptionsWithSources(command);
    await runCommand(storeCommand, opts, domainInput(opts), commandRuntime);
  });
  withS3Options(
    catalog.command("s3").helpGroup("Collect · 采集与分析:").description("按 ls/stat/cat 浏览 Service 的 S3 bucket、前缀与对象（只读）")
      .addHelpText("after", `
分析思路：
  通过 Service 的 S3 连接列举、查看对象元数据或读取有界内容，保留对象路径与读取范围。
结果解读：
  列举结果和截断内容不是完整 bucket 快照；判断对象是否正确时核对路径、大小与实际读取内容。
`),
  ).action(async (action, path, _opts, command: CommandT) => {
    const opts = commandOptionsWithSources(command);
    const { s3Command } = await import("../collect/s3/command");
    await runCommand(s3Command, opts, { ...domainInput(opts), action, path }, commandRuntime);
  });
  withDbOptions(
    catalog.command("db").helpGroup("Collect · 采集与分析:").description("发现 Service 可访问的数据库与表，执行有界只读 SQL")
      .addHelpText("after", `
分析思路：
  先发现 Service 可访问的库表，再使用有界只读 SQL 验证具体数据假设。
结果解读：
  空结果需要核对库表、条件和访问范围；被行数或时间预算截断的结果不能代表全部数据。
`),
  ).action(async (_opts, command: CommandT) => {
    const opts = commandOptionsWithSources(command);
    // SQL parsing belongs to db execution; help and unrelated commands do not load its grammar.
    const { dbCommand } = await import("../collect/db/command");
    await runCommand(dbCommand, opts, domainInput(opts), commandRuntime);
  });
  withLogOptions(
    catalog.command("log").helpGroup("Collect · 采集与分析:").description("按 Service / 时间范围采集 Pod 日志；可选业务 ID 关联 trace 与对象日志（只读）")
      .addHelpText("after", `
分析思路：
  按 Service 与时间窗口读取日志；有业务 ID 时关联 trace 与对象日志，保留各来源结果。
结果解读：
  无匹配日志不证明请求未发生；先检查窗口、目标副本、日志保留范围及读取失败或截断。
`),
    "",
  ).action(async (positionalBizIds, opts: RawBizIdOptions<CollectLogCliOpts>, command: CommandT) => {
    opts = commandOptionsWithSources(command);
    const commandOpts = normalizeBizIdOptions(positionalBizIds, opts);
    await runCommand(logCommand, commandOpts, domainInput(commandOpts), commandRuntime);
  });
  withDataOptions(
    catalog.command("data").helpGroup("Collect · 采集与分析:").description("先扩展业务 ID，再汇集 Service Catalog 声明的数据（由当前 Plugin 声明，只读）")
      .addHelpText("after", `
分析思路：
  从业务 ID 出发，沿现场证据中的 Identity 关系汇集各 Service 的关联记录。
结果解读：
  采集成功表示取得数据，业务是否成功仍需解释记录；核对来源、观察时间和关联范围内的缺口。
`),
    [],
  ).action(async (positionalBizIds, opts: RawBizIdOptions<CollectDataCliOpts>, command: CommandT) => {
    opts = commandOptionsWithSources(command);
    const commandOpts = normalizeBizIdOptions(positionalBizIds, opts);
    await runCommand(dataCommand, commandOpts, domainInput(commandOpts), commandRuntime);
  });
  withInspectOptions(
    catalog.command("inspect").helpGroup("Collect · 采集与分析:").description("检查 Service 的 workload、配置、Toolchain 与应用依赖（只读）")
      .addHelpText("after", `
分析思路：
  按 Service 查看 Workload 运行态，并按所选范围补充部署配置与现场依赖版本。
结果解读：
  声明的配置和资源量不等于进程当前值或实际用量；重启、OOM 与退避状态需结合日志和时间线判断。
`),
  ).action(async (opts, command: CommandT) => {
    opts = commandOptionsWithSources(command);
    await runCommand(inspectCommand, opts, domainInput(opts), commandRuntime);
  });
  withTenantOptions(
    catalog.command("tenant").helpGroup("Collect · 采集与分析:").description("汇总 Plugin 提供的租户粒度业务事实（只读）")
      .addHelpText("after", `
分析思路：
  以租户身份汇集 Plugin 提供的业务事实，保留各来源的配置与能力信息。
结果解读：
  租户可见的配置或模型目录不证明实际调用成功；模型调用用 model，单请求记录用 data / trace。
`),
  ).action(async (opts: CollectTenantCliOptions, command: CommandT) => {
    opts = commandOptionsWithSources(command);
    await runCommand(tenantCommand, opts, domainInput(opts), commandRuntime);
  });
  withCaseOptions(
    catalog.command("case").helpGroup("Collect · 采集与分析:").description("列出 Case；选择一个或多个 HTTP Case 后发送并生成诊断报告")
      .addHelpText("after", `
分析思路：
  从 Case 目录选择请求，确认目标与执行位置后实际发送，并保留协议响应和诊断证据。
结果解读：
  检查请求是否执行及响应判定；一次通过只覆盖该 Case、身份和执行位置，不能代表全部业务可用。
`),
  ).action(async (opts: CollectHttpCliOpts & { caseFile?: string; caseset?: string; cases?: string; send?: boolean; baseUrl?: string; yes?: boolean }, command: CommandT) => {
    opts = commandOptionsWithSources(command);
    await withInteractionOptions(opts, () => runStandaloneCommand("doctor case", async () => {
      const active = plugin ?? await loadActivePlugin();
      const sources = doctorCaseCatalog(active, opts.caseFile);
      for (const source of sources) {
        writeOutput(`${source.caseSet.caseset} (${source.source}${source.service ? `/${source.service}/${source.sourceId}` : ""})\n`);
        for (const item of source.caseSet.cases) {
          writeOutput(`  ${item.id}${item.desc ? `  ${item.desc}` : ""}\n`);
        }
      }
      for (const { service, source } of active?.services.caseSources() ?? []) {
        if (!sources.some(item => item.service === service.name && item.sourceId === source.id)) {
          writeOutput(`${service.name}/${source.id} (plugin · runtime Cases)${source.description ? `  ${source.description}` : ""}\n`);
        }
      }
      if (!opts.send && !isInteractive()) return;
      const selection = await selectDoctorCases({ catalog: sources, command: "http", caseSetId: opts.caseset, caseIds: opts.cases });
      if (!selection) return 130;
      if (!opts.send) {
        const send = await promptListedChoice({
          question: `发送 ${selection.source.caseSet.caseset}/${selection.cases.map((item) => item.id).join(", ")}？[y/N] `,
          match: (answer) => /^(y|yes)$/i.test(answer) ? true : /^(n|no)$/i.test(answer) ? false : undefined,
          invalidMessage: "请输入 y/yes 或 n/no。", emptyValue: false,
        });
        if (!send) return;
      }
      let baseUrl = opts.baseUrl;
      if (!baseUrl && isInteractive()) {
        baseUrl = await promptListedChoice({
          question: "发送目标 base URL（例如 http://127.0.0.1:8000；q 取消）：",
          match: (answer) => {
            try {
              const url = new URL(answer);
              return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? answer : undefined;
            } catch { return undefined; }
          },
          invalidMessage: "请输入无凭据的 http(s) URL。",
        });
      }
      if (!baseUrl) throw new Error("发送 Case 需要 --base-url");
      await runCommand(caseCommand, opts, domainInput({ ...opts, caseset: selection.source.caseSet.caseset,
        cases: selection.cases.map((item) => item.id).join(","), baseUrl }), commandRuntime);
    }));
  });
  withNetworkOptions(
    catalog.command("net").helpGroup("Collect · 采集与分析:").description("协调目标服务 Pod 短时抓包，以跟踪或守候模式产出 NetBundle")
      .addHelpText("after", `
分析思路：
  在所选 Service 的 Pod 上进行有界抓包，保存采集范围与 NetBundle，交给 neta 离线分析。
结果解读：
  未覆盖的 Pod、时段或加密流量可能留下缺口；未捕获到报文不证明调用没有发生。
`),
  ).action(async (opts: CollectNetworkCliOpts, command: CommandT) => {
    opts = commandOptionsWithSources(command);
    await runCommand(netCommand, opts, domainInput(opts), commandRuntime);
  });
  catalog
    .command("neta [input]").helpGroup("Collect · 采集与分析:")
    .description("纯离线分析 NetBundle，重建业务调用并生成 Findings、Coverage 与可视化报告")
    .addHelpText("after", `
分析思路：
  从已有 NetBundle 重建调用与时间线，结合捕获范围给出 Findings 和 Coverage。
结果解读：
  结论受抓包完整性与协议可解析性限制；结合 trace / log 交叉验证，缺口需要重新采集补足。
`)
    .option("--trace-id <ids>", "逗号分隔的一个或多个 trace ID（缺省读取 NetBundle）")
    .option("--capture-id <id>", "覆盖 NetBundle 中的染色 ID")
    .option("-o, --output <path>", "报告输出路径或前缀；生成同名 Markdown、HTML 与 JSON")
    .action(async (input, opts, command: CommandT) => {
      opts = commandOptionsWithSources(command);
      await runStandaloneCommand("doctor neta", () => runAnalyzeNetwork(input, opts));
    });
  withMcpOptions(
    catalog.command("mcp").helpGroup("Collect · 采集与分析:").description("对 MCP tool 执行多维取证与规则分析，产出 Evidence Bundle 或 HTML")
      .addHelpText("after", `
分析思路：
  先确认配置与运行时 tool，再执行获准的 MCP 调用；有 HTTP 映射时可比较直连路径。
结果解读：
  tools/list 成功只证明工具发现；结合 tools/call、直连结果与日志定位失败边界。
`),
  ).action(async (opts, command: CommandT) => {
    opts = commandOptionsWithSources(command);
    await runCommand(mcpCommand, opts, domainInput(opts), commandRuntime);
  });
  withModelOptions(
    catalog.command("model").helpGroup("Collect · 采集与分析:").description("从模型目录选择可用模型，执行 validation 与真实 inference")
      .addHelpText("after", `
分析思路：
  按租户与模型身份检查 backend validation，再执行所选 Case 的真实 inference。
结果解读：
  validation 通过不保证推理成功；串行性能样本只反映本次请求，不能作为并发容量结论。
`),
  ).action(async (opts, command: CommandT) => {
    opts = commandOptionsWithSources(command);
    await runCommand(modelCommand, opts, domainInput(opts), commandRuntime);
  });
  withMetricOptions(
    catalog.command("metric").helpGroup("Collect · 采集与分析:").description("采集 Service 声明的 Prometheus metrics，执行 detector 并生成离线 HTML 图表")
      .addHelpText("after", `
分析思路：
  按 Service 声明采集和查询指标，在同一窗口内保留曲线、规则发现与覆盖缺口。
结果解读：
  先核对数据源、窗口和指标口径；空数据不是零值或正常，跨窗口或副本的数值不能直接归因。
`),
  ).action(async (opts, command: CommandT) => {
    opts = commandOptionsWithSources(command);
    await runCommand(metricCommand, opts, domainInput(opts), commandRuntime);
  });
  withEvalOptions(
    catalog.command("eval").description("按 canonical CaseSet 触发真实请求并采集关联 trace、log、data，不做质量评分")
      .addHelpText("after", `
分析思路：
  从 CaseSet 选择 Case，逐例触发真实请求，并关联采集 trace、log、data。
结果解读：
  分别检查请求执行与证据采集状态；报告用于复查实际行为，回答质量需另行评价。
`),
  ).action(async (opts, command: CommandT) => {
    opts = commandOptionsWithSources(command);
    await runCommand(evalCommand, opts, domainInput(opts), commandRuntime);
  });
  withPerfOptions(
    catalog.command("perf").description("发起受控业务压测，并在同一窗口交付 metric、trace 与 log 证据")
      .addHelpText("after", `
分析思路：
  按所选 Case 产生受控负载，同时采集同窗口的 metric、trace 与 log 以解释性能现象。
结果解读：
  比较实际负载、错误率、延迟与证据覆盖；单次结果仅适用于本次目标、Case 和负载条件。
`),
  ).action(async (opts, command: CommandT) => {
    opts = commandOptionsWithSources(command);
    await runCommand(perfCommand, opts, domainInput(opts), commandRuntime);
  });

  const visibleCommands = new Set(selectVisibleCommands(catalog.commands, distribution.commands ?? DOCTOR_COMMANDS));
  for (const command of catalog.commands) {
    program.addCommand(command, { hidden: !visibleCommands.has(command) });
  }
  applyOptionDefaults(program, distribution.optionDefaults);
  applyCommandDefaults(program, distribution.commandDefaults);
  configureProfileHelp(program);
  configureDeliveryHelp(program);
  // Root action owns unknown-command diagnostics. Set this after child creation
  // so subcommands retain Commander's strict argument validation.
  program.allowExcessArguments(true);
  return program;
}

export async function main(embedded: Distribution = {}, host: DoctorHostOptions = {}) {
  const { path, argv } = extractDistributionArgument(process.argv);
  let distribution = embedded;
  if (path) {
    const manifest = loadDistributionManifest(path);
    // Help and release identity must remain available before installing a Plugin.
    const presentationOnly = argv.length === 2 || argv.includes("--help") || argv.includes("-h")
      || argv[2] === "help" || argv.includes("--version") || argv.includes("-V");
    const plugin = manifest.plugin && !presentationOnly
      ? embedded.plugin && `${embedded.plugin.id}@${embedded.plugin.version}` === manifest.plugin
        ? embedded.plugin
        : await loadInstalledPlugin(manifest.plugin)
      : undefined;
    distribution = { ...manifest, plugin };
  }
  const program = createDoctorProgram(distribution, host);

  if (argv.length === 2) {
    program.outputHelp();
    return;
  }
  try {
    await withLogger(distribution.logLevel ?? "info", () => program.parseAsync(argv));
  } catch (error) {
    if (error instanceof CommanderError && error.code === "doctor.versionDisplayed") return;
    throw error;
  }
}

export function startDoctor(distribution: Distribution = {}, host: DoctorHostOptions = {}): void {
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
  main(distribution, host).catch((err) => {
    reportError(err, {
      context: "doctor main",
      summary: "fatal",
      displayMessage: mapErrorMessage(err),
      plugin: pluginIdentity,
    });
    process.exit(1);
  });
}
