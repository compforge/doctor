#!/usr/bin/env bun
import { terminalStdout } from "../terminal/output";
import type { PluginDefinition } from "@compforge/doctor-plugin";
// 入口只做子命令路由：
//   doctor chat              → 默认本地 Agent；--server 显式选择远端 Agent（app/repl.tsx）
//   doctor mem               → attach Python 进程并回传 PyHeap dump（collect/）
//   doctor mema              → 在本机解析并诊断一个或多个 PyHeap dump（collect/）
//   doctor cpu               → 无 server 直连采集：pod Python CPU 线程栈证据包（collect/）
//   doctor trace             → 无 server 直连采集：OpenSearch 下载 trace 全量 span（collect/）
//   doctor store             → 从 Service Pod 提取 Store 配置并诊断 DB/VDB/S3/Redis（collect/）
//   doctor log               → 无 server 直连采集：按 biz ID 解析 trace 并聚合服务 pod 日志（collect/）
//   doctor data              → 先扩展业务 ID，再汇集各 Service 声明的数据（collect/）
//   doctor config            → 采集 Service 的部署声明配置与可选租户配置（collect/）
//   doctor http              → 从 YAML 重放多轮 HTTP 请求并分析响应（collect/）
//   doctor net               → 协调目标服务 Pod 短时抓包并主动发起染色请求（collect/）
//   doctor mcp               → MCP tool 多维取证与规则分析（collect/）
//   doctor model             → 从模型目录选择目标并执行 validation/inference（collect/）
//   doctor metric            → 基于 Prometheus 或内嵌 Prombed 采集并可视化 Service metrics
//   doctor install           → 向选定 Pod container 安装 GDB
//   doctor init              → 首次初始化 local profile
//   doctor profile           → 交互选择并持久切换 config.yaml.default_profile
// CLI 是多能力入口，bare `doctor` 显示 core 与当前注入 Plugin 提供的全部子命令帮助。
import { Command, type Command as CommandT } from "commander";
import { formatDoctorVersion } from "./version";
import { mapErrorMessage } from "../protocol";
import { runRepl } from "./repl";
import { runCollectMemory, runCollectMemoryAnalysis } from "../collect/memory";
import { runCollectCpu } from "../collect/cpu";
import { runCollectTrace } from "../collect/trace";
import { runCollectStore } from "../collect/store";
import { runCollectLog } from "../collect/log";
import { runCollectData } from "../collect/data";
import { runCollectConfig } from "../collect/config/index";
import { REDIS_DEFAULTS } from "../collect/redis";
import { runCollectHttp } from "../collect/http";
import {
  NETWORK_DEFAULTS,
  runAnalyzeNetwork,
  runCollectNetwork,
} from "../collect/network";
import { runCollectMcp } from "../collect/mcp";
import { runCollectModel } from "../collect/model";
import { runCollectMetric } from "../collect/metric";
import { runDebug } from "../provision/debug";
import { runDoctorImage } from "../provision/image";
import { runInstall, validateInstallOptions } from "../provision/install";
import type { CliFlags } from "../protocol";
import { reportError } from "./error-log";
import { runInit } from "./init";
import { runProfile } from "./profile";
import { PLUGIN_COMMAND_CAPABILITIES } from "./plugin-command-capabilities";
import { loadActivePlugin } from "../plugin";
import { runPluginInstall, runPluginUninstall } from "./plugin";
import { runCommand, runPluginCommand, runStandaloneCommand } from "./command";

// REPL 选项只属于 chat 子命令，root 保持为中性的能力索引。
function withReplOptions(cmd: CommandT): CommandT {
  return cmd
    .option("-p, --profile <name>", "profile name from ~/.doctor/config.yaml")
    .option("--server", "use the doctor-server configured by the profile", false)
    .option("--resume [conv_id]", "resume a previous conversation (latest if no id given)")
    .option("-c, --config <path>", "config file path (default: ~/.doctor/config.yaml)")
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
function withApprovalOptions(cmd: CommandT): CommandT {
  return cmd.option("-y, --yes", "自动确认本次命令的所有高风险操作", false);
}

function withK8sProcessTargetOptions(cmd: CommandT): CommandT {
  return withApprovalOptions(
    cmd
      .option("-n, --namespace <ns>", "目标 namespace（缺省时按 profile 或交互选择，非交互默认 default）")
      .option("-p, --pod <pod>", "目标 pod 名或关键词（缺省时列出候选）")
      .option("-c, --container <name>", "多容器 pod 时指定容器")
      .option("--pid <pid>", "目标进程 pid（缺省从 procscan 自动选）")
      .option(
        "--mode <mode>",
        "影响等级：observe、overhead 或 disrupt（缺省时交互选择；关键写操作需 [y/N] 确认）",
      ),
  )
    .option("--kubeconfig <path>", "kubeconfig 路径（缺省走 kubectl 默认查找）")
    .option("--context <name>", "kubeconfig context")
    .option("--profile <name>", "从 ~/.doctor/config.yaml 的该 profile 取 kubeconfig（--kubeconfig 优先）")
    .option("--config <path>", "config 文件路径（默认 ~/.doctor/config.yaml，仅 --profile 时读取）");
}

function withMemOptions(cmd: CommandT): CommandT {
  return withApprovalOptions(
    cmd
      .option("-n, --namespace <ns>", "目标 namespace（缺省时按 profile 或交互选择，非交互默认 default）")
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
      .option("--cleanup-remote", "heap 成功回传后删除执行容器内临时文件", false),
  )
    .option("--kubeconfig <path>", "kubeconfig 路径（缺省走 kubectl 默认查找）")
    .option("--context <name>", "kubeconfig context")
    .option("--profile <name>", "从 ~/.doctor/config.yaml 的该 profile 取 kubeconfig（--kubeconfig 优先）")
    .option("--config <path>", "config 文件路径（默认 ~/.doctor/config.yaml，仅 --profile 时读取）")
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
  return cmd
    .requiredOption("--biz-id <id>", "业务 ID；Plugin traceId capability 先解析为 trace_id")
    .option("-n, --namespace <ns>", "业务 Service 所在 namespace（profile 配置兜底，默认 default）")
    .option("--service <name>", "OpenSearch backend service 覆盖值")
    .option("--endpoint <url>", "Doctor Host 直连 OpenSearch 的地址；缺省也读 DOCTOR_OPENSEARCH_URL")
    .option("--host <url>", "--endpoint 的兼容别名（已弃用）")
    .option("--index <expr>", "索引表达式（默认 jaeger-span-*）")
    .option("--index-date <date>", "jaeger-span-YYYY-MM-DD 单日索引（--index 给了则忽略）")
    .option("--username <user>", "OpenSearch 用户名（缺省读 DOCTOR_OPENSEARCH_USERNAME）")
    .option("--password <pass>", "OpenSearch 密码（缺省读 DOCTOR_OPENSEARCH_PASSWORD）")
    .option("--page-size <n>", "分页拉取批大小", "1000")
    .option("-f, --format <format>", "输出格式：html 或 bundle", "html")
    .option("--kubeconfig <path>", "kubeconfig 路径（缺省走 kubectl 默认查找）")
    .option("--context <name>", "kubeconfig context")
    .option("--profile <name>", "从 ~/.doctor/config.yaml 的该 profile 取 kubeconfig（--kubeconfig 优先）")
    .option("--config <path>", "config 文件路径（默认 ~/.doctor/config.yaml，仅 --profile 时读取）")
    .option("-o, --output <path>", "输出路径（默认 ./doctor-trace-<trace-id>-<时间戳>.html）");
}

function withStoreOptions(cmd: CommandT): CommandT {
  return cmd
    .option("--type <types>", "逗号分隔的 Store 类型：db、vdb、s3、redis；交互终端缺省时多选")
    .option("--service <name>", "提供 Store 配置的业务 Service；缺省时从 Catalog capability 选择")
    .option("--store <id>", "Service 声明多个同类 Store 时指定 capability ID")
    .option("-p, --pod <pod>", "读取 Store 运行时配置的 Service Pod")
    .option("-c, --container <name>", "多容器 Pod 中读取配置的 Container")
    .option("-n, --namespace <ns>", "业务 Service 所在 namespace")
    .option("--backend-service <name>", "VDB backend Kubernetes Service 覆盖值")
    .option("--endpoint <url>", "VDB backend 的 Doctor Host 直连地址覆盖值")
    .option("--s3-prefix <prefix>", "S3 对象画像范围；缺省使用 Service 配置的 bucket prefix")
    .option("--s3-max-objects <n>", "S3 对象画像最多扫描的对象数", "100000")
    .option("--s3-scan-timeout <seconds>", "S3 对象画像总时间预算", "120")
    .option("--database <n>", "Redis 深度分析的 database")
    .option("--quick", "Redis 只采拓扑、容量和运行状态，不扫描 key", false)
    .option("--keystats", "Redis 强制对所有 master 运行 keyStats 深度探测", false)
    .option("--max-keys <n>", "Redis 最多检查的 key 总数", String(REDIS_DEFAULTS.maxKeys))
    .option("--max-keys-per-second <n>", "Redis 每秒最多检查的 key 数", String(REDIS_DEFAULTS.maxKeysPerSecond))
    .option("--top <n>", "Redis 各类 TopN 条目数", String(REDIS_DEFAULTS.top))
    .option("--show-key-names", "Redis TopN 显示完整 key 名", REDIS_DEFAULTS.showKeyNames)
    .option("--no-show-key-names", "Redis TopN 隐藏完整 key 名并使用哈希摘要")
    .option("-f, --format <format>", "输出格式：bundle、html 或 md", "html")
    .option("--kubeconfig <path>", "kubeconfig 路径")
    .option("--context <name>", "kubeconfig context")
    .option("--profile <name>", "从 profile 取 namespace / kubeconfig")
    .option("--config <path>", "config 文件路径（默认 ~/.doctor/config.yaml）")
    .option("-o, --output <path>", "输出路径（默认 ./doctor-store-<type>-<时间戳>.html；后缀按 --format 自动补全）");
}

function withLogOptions(cmd: CommandT, defaultServices: string): CommandT {
  const defaultDescription = defaultServices || "当前 Plugin 声明的默认 Service";
  return cmd
    .requiredOption("--biz-id <id>", "用于解析 trace_id 的业务 ID（trace_id / message_id / conversation_id 等）")
    .option("-n, --namespace <ns>", "目标服务所在 namespace（缺省时按 profile 或交互选择，非交互默认 default）")
    .option(
      "--services <names>",
      `逗号分隔的 Kubernetes Service；缺省时交互多选，非交互默认 ${defaultDescription}`,
    )
    .option("--since <duration>", "kubectl 日志回看窗口（缺省时优先从 UUIDv7 ID 推导，否则为 6h）")
    .option("--since-time <timestamp>", "从指定时间开始，优先于 --since")
    .option("--errors-only", "ID 过滤后只保留常见错误日志", false)
    .option("--pattern <regex>", "ID 过滤后继续按正则筛选")
    .option("-f, --format <format>", "输出格式：html 或 bundle（含 HTML、JSONL 和 raw）", "html")
    .option("--kubeconfig <path>", "kubeconfig 路径（缺省走 kubectl 默认查找）")
    .option("--context <name>", "kubeconfig context")
    .option("--profile <name>", "从 ~/.doctor/config.yaml 的该 profile 取 kubeconfig（--kubeconfig 优先）")
    .option("--config <path>", "config 文件路径（默认 ~/.doctor/config.yaml，仅 --profile 时读取）")
    .option("-o, --output <path>", "输出路径（后缀按 --format 自动补全）");
}

function withDataOptions(cmd: CommandT, defaultServiceNames: readonly string[]): CommandT {
  const defaultDescription = defaultServiceNames.length
    ? defaultServiceNames.join(",")
    : "当前 Plugin 声明的 data provider";
  return cmd
    .requiredOption("--biz-id <id>", "需要汇集关联数据的业务 ID")
    .option(
      "--services <names>",
      `逗号分隔的 data provider；缺省交互选择，非交互默认 ${defaultDescription}`,
    )
    .option("-n, --namespace <ns>", "目标 Service 所在 namespace（profile 配置兜底，默认 default）")
    .option("-f, --format <format>", "输出格式：json（stdout）或 html", "json")
    .option("--kubeconfig <path>", "kubeconfig 路径")
    .option("--context <name>", "kubeconfig context")
    .option("--profile <name>", "从 profile 取 kubeconfig；数据源身份仅作服务运行时配置的兜底")
    .option("--config <path>", "config 文件路径（默认 ~/.doctor/config.yaml）")
    .option("-o, --output <path>", "HTML 报告输出路径（后缀自动补全）");
}

function withConfigOptions(cmd: CommandT): CommandT {
  return cmd
    .option("--services <names>", "逗号分隔的 Kubernetes Service；缺省时交互多选，非交互必须指定")
    .option("--deployment-config", "确认采集 Deployment Env/ConfigMap；交互模式缺省时询问")
    .option("--tenant-id <id>", "同时读取该租户的 Plugin 配置并按列对照")
    .option("--tenant-name <name>", "通过租户目录精确解析租户名，并读取 Plugin 配置")
    .option("--tenant-config-service <name>", "提供租户配置的 Kubernetes Service；缺省由 Plugin 声明")
    .option("--tenant-directory-service <name>", "租户目录 Kubernetes Service；缺省由 Plugin 声明")
    .option("--tenant-directory-port <port>", "租户目录 Service HTTP 端口；缺省由 Plugin 声明")
    .option("-n, --namespace <ns>", "目标 Service 所在 namespace（profile 配置兜底，默认 default）")
    .option("-f, --format <format>", "输出格式：json（stdout）、html 或 md", "html")
    .option("--kubeconfig <path>", "kubeconfig 路径")
    .option("--context <name>", "kubeconfig context")
    .option("--profile <name>", "从 profile 取 namespace / kubeconfig；DB 身份仅作租户配置兜底")
    .option("--config <path>", "config 文件路径（默认 ~/.doctor/config.yaml）")
    .option("-o, --output <path>", "HTML/Markdown 报告输出路径（后缀自动补全）");
}

function withHttpOptions(cmd: CommandT): CommandT {
  return cmd
    .option("--location <local|pod>", "请求执行位置；交互终端缺省时选择，非交互默认 local")
    .option("-p, --pod <pod>", "Pod 名或关键词；指定后自动使用 pod 执行位置")
    .option("-c, --container <name>", "Pod 内执行 HTTP 请求的 Container")
    .option("-n, --namespace <ns>", "Pod 所在 namespace（profile 配置兜底，交互终端可选择）")
    .option("--file <path>", "doctor-http/v1 YAML 请求场景文件；交互终端缺省时从当前目录选择")
    .option("-e, --example [path]", "生成 doctor-http/v1 示例文件（默认 ./example.yaml）")
    .option("--request <ids>", "逗号分隔的 request id；交互终端缺省时选择，非交互执行全部")
    .option("--repeat <n>", "整个请求列表执行轮数", "1")
    .option("--interval <seconds>", "每轮之间的等待时间", "0")
    .option("--timeout <seconds>", "覆盖文件中的单请求超时")
    .option("--inspect-timeout <seconds>", "每个 URL host:port 的 DNS/TCP Inspect 超时", "3")
    .option("--max-size <mib>", "覆盖文件中的单响应最大采集容量")
    .option("-f, --format <format>", "输出格式：bundle（含 HTML 和原始响应）、html 或 md", "html")
    .option("--kubeconfig <path>", "Pod 执行位置使用的 kubeconfig 路径")
    .option("--context <name>", "Pod 执行位置使用的 kubeconfig context")
    .option("--profile <name>", "Pod 执行位置从 profile 取 namespace / kubeconfig")
    .option("--config <path>", "config 文件路径（默认 ~/.doctor/config.yaml）")
    .option("-o, --output <path>", "输出路径（后缀按 --format 自动补全）");
}

function withNetworkOptions(cmd: CommandT): CommandT {
  return cmd
    .option("--file <path>", "doctor-http/v1 YAML 场景文件；选择后进入跟踪模式，不选择则进入守候模式")
    .option("-n, --namespace <ns>", "目标服务所在 namespace（profile 兜底，默认 default）")
    .option("--services <names>", "逗号分隔的 Kubernetes Service；交互终端缺省时多选，非交互必须指定")
    .option("--timeout <seconds>", "跟踪请求或守候窗口的最长时间", String(NETWORK_DEFAULTS.timeoutSeconds))
    .option("--drain <seconds>", "请求结束后继续抓包的时间", String(NETWORK_DEFAULTS.drainSeconds))
    .option("--max-pcap-size <mib>", "每个 Pod 的 PCAP 最大容量", String(NETWORK_DEFAULTS.maxPcapMiB))
    .option("--max-response-size <mib>", "响应体最大采集容量", String(NETWORK_DEFAULTS.maxResponseMiB))
    .option("--filter <bpf>", "覆盖按 Service 端口生成的 tcpdump BPF 粗过滤条件")
    .option("--cleanup-remote", "PCAP 成功回传并校验后清理 Pod 内本次抓包", false)
    .option("--kubeconfig <path>", "kubeconfig 路径")
    .option("--context <name>", "kubeconfig context")
    .option("--profile <name>", "从 profile 取 namespace / kubeconfig")
    .option("--config <path>", "config 文件路径（默认 ~/.doctor/config.yaml）")
    .option("-o, --output <path>", "NetBundle 输出路径（默认 ./doctor-net-<时间戳>.tar.gz）");
}

function withMcpOptions(cmd: CommandT): CommandT {
  return withApprovalOptions(
    cmd
      .option("-n, --namespace <ns>", "MCP Service 所在 namespace（profile 兜底，默认 default）")
      .option("--server <name>", "MCP server：server name 或 tenant/server；缺省时交互选择")
      .option("--tool <name>", "MCP tool name；缺省时交互选择")
      .option("--args <json>", "tool arguments JSON object")
      .option("--args-file <path>", "从文件读取 tool arguments JSON object")
      .option("--timeout <seconds>", "单步请求超时（1..600 秒）", "60")
      .option("--gateway-service <name>", "提供 MCP capability 的 Kubernetes Service；缺省由 Plugin Catalog 唯一推断"),
  )
    .option("--kubeconfig <path>", "kubeconfig 路径")
    .option("--context <name>", "kubeconfig context")
    .option("--profile <name>", "从 profile 取 namespace / kubeconfig")
    .option("--config <path>", "config 文件路径（默认 ~/.doctor/config.yaml）")
    .option("-f, --format <format>", "输出格式：bundle 或 html", "bundle")
    .option(
      "-o, --output <path>",
      "输出路径（默认 ./doctor-mcp-YYYYMMDDHHmmss.tar.gz；后缀按 --format 自动补全）",
    );
}

function withModelOptions(cmd: CommandT): CommandT {
  return cmd
    .option("-n, --namespace <ns>", "模型目录/推理服务所在 namespace（profile 兜底，默认 default）")
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
    .option("--kubeconfig <path>", "kubeconfig 路径")
    .option("--context <name>", "kubeconfig context")
    .option("--profile <name>", "从 profile 取 namespace / kubeconfig")
    .option("--config <path>", "config 文件路径（默认 ~/.doctor/config.yaml）")
    .option("-o, --output <path>", "模型性能 HTML 报告路径");
}

function withMetricOptions(cmd: CommandT): CommandT {
  return cmd
    .option("--services <names>", "逗号分隔的 metric provider；缺省时交互多选，非交互使用全部已注册 Service")
    .option("--watch <duration>", "采集窗口：0、1m、2m、5m、10m 或 until-interrupt；非交互默认 0")
    .option("--interval <duration>", "内嵌 Prombed 抓取间隔（500ms..60s）", "5s")
    .option("--prometheus <url>", "Prometheus 地址；优先于 profile.prometheus.url")
    .option("-n, --namespace <ns>", "未配置 Prometheus 时，目标 Service 所在 namespace")
    .option("--kubeconfig <path>", "未配置 Prometheus 时使用的 kubeconfig 路径")
    .option("--context <name>", "kubeconfig context")
    .option("--profile <name>", "从 profile 取 Prometheus 或 namespace / kubeconfig")
    .option("--config <path>", "config 文件路径（默认 ~/.doctor/config.yaml）")
    .option("-o, --output <path>", "单文件 HTML 报告输出路径");
}

async function resolveVersionPlugin(plugin: PluginDefinition | undefined): Promise<PluginDefinition | undefined> {
  if (plugin) return plugin;
  return process.argv.slice(2).some((argument) => argument === "--version" || argument === "-V")
    ? loadActivePlugin()
    : undefined;
}

export async function main(plugin?: PluginDefinition) {
  const versionPlugin = await resolveVersionPlugin(plugin);
  const program = new Command();
  const version = formatDoctorVersion(versionPlugin);
  program
    .name("doctor")
    .description([
      "面向应用与基础设施的本地诊断工具。",
      "Core 提供通用 Target 访问与证据编排，Plugin 提供业务目标和数据语义；默认旁路运行、证据优先。",
    ].join("\n"))
    .version(version);

  withReplOptions(
    program.command("chat").description("交互式 AI 问诊（默认本地；--server 显式连接 profile 中的 doctor-server）"),
  ).action(async (opts) => {
    const flags = toReplFlags(opts);
    await runCommand({ name: "doctor chat" }, flags, async (commandContext) => {
      const activePlugin = plugin ?? await loadActivePlugin();
      activePlugin?.validateConfig?.(commandContext.profile.pluginConfig);
      return runRepl(flags, activePlugin, commandContext);
    });
  });

  program
    .command("init")
    .description("首次初始化 local profile")
    .option("-c, --config <path>", "config file path (default: ~/.doctor/config.yaml)")
    .action(async (opts) => {
      await runStandaloneCommand("doctor init", () => runInit(opts));
    });

  program
    .command("profile [name]")
    .description("交互选择 profile，或指定名称并持久为默认 profile")
    .option("-c, --config <path>", "config file path (default: ~/.doctor/config.yaml)")
    .action(async (name, opts) => {
      await runStandaloneCommand("doctor profile", () => runProfile(name, opts));
    });

  program
    .command("version")
    .description("显示版本信息")
    .action(async () => {
      const activePlugin = plugin ?? await loadActivePlugin();
      terminalStdout.info(`${formatDoctorVersion(activePlugin)}\n`);
    });

  const pluginCommand = program.command("plugin").description("安装和卸载 Doctor Plugin");
  pluginCommand
    .command("install <archive>")
    .description("安装并加载 Plugin 归档")
    .action(runPluginInstall);
  pluginCommand
    .command("uninstall <ref>")
    .description("卸载精确 plugin@version")
    .action(runPluginUninstall);

  program
    .command("help")
    .description("显示帮助信息")
    .action(() => {
      program.outputHelp();
    });

  program
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
    .option("-y, --yes", "未显式指定落点时，自动确认可选的 Doctor Host load", false)
    .option("--kubeconfig <path>", "发现 registry 候选使用的 kubeconfig 路径")
    .option("--context <name>", "发现 registry 候选使用的 kubeconfig context")
    .option("--profile <name>", "从 profile 取 kubeconfig 和 registry 凭据")
    .option("--config <path>", "config 文件路径")
    .action(async (image, opts) => {
      const needsKubernetes = Boolean(opts.registry || image || !opts.host);
      await runCommand(
        { name: "doctor image", environment: { kubernetes: needsKubernetes } },
        opts,
        (context) => runDoctorImage(image, opts, context),
      );
    });

  program
    .command("debug")
    .allowExcessArguments(false)
    .description("为目标 Pod 启动或复用具备 ptrace 权限的 debug 临时容器")
    .option("-n, --namespace <ns>", "目标 namespace")
    .option("-p, --pod <pod>", "单个目标 Pod 名或关键词；交互终端缺省时多选")
    .option("--services <names>", "逗号分隔的 Service；为其全部 Running Pod 准备 debug container")
    .option("-c, --container <name>", "目标业务容器")
    .option("--image <image>", "已发布且集群可拉取的 debug image")
    .option("--kubeconfig <path>", "kubeconfig 路径")
    .option("--context <name>", "kubeconfig context")
    .option("--profile <name>", "从 profile 取 namespace、kubeconfig 或 kube.debug_image")
    .option("--config <path>", "config 文件路径")
    .option("-y, --yes", "自动确认 Pod mutation", false)
    .action(async (opts) => {
      await runCommand(
        { name: "doctor debug", environment: { kubernetes: true } },
        opts,
        (context) => runDebug(opts, context),
      );
    });

  program
    .command("install")
    .allowExcessArguments(false)
    .description("向目标 Pod container 安装排查程序；首版支持 GDB")
    .option("-n, --namespace <ns>", "目标 namespace")
    .option("-p, --pod <pod>", "目标 Pod 名或关键词")
    .option("-c, --container <name>", "要安装 GDB 的目标 container")
    .option("--program <name>", "非交互调用指定要安装的程序；首版仅支持 gdb")
    .option("--tar <path>", "指定与 Target 平台和 kernel 兼容的 doctor-packages/v1 离线 tar")
    .option("-f, --format <format>", "输出 GDB 兼容性报告：md 或 json")
    .option("-o, --output <path>", "兼容性报告路径；未指定 --format 时按 .json 后缀推断，否则使用 md")
    .option("--kubeconfig <path>", "kubeconfig 路径")
    .option("--context <name>", "kubeconfig context")
    .option("--profile <name>", "从 profile 取 namespace 和 kubeconfig")
    .option("--config <path>", "config 文件路径")
    .option("-y, --yes", "自动确认修改目标 container 可写层", false)
    .action(async (opts) => {
      await runCommand(
        {
          name: "doctor install",
          validate: () => validateInstallOptions(opts),
          environment: { kubernetes: true },
        },
        opts,
        (context) => runInstall(opts, context),
      );
    });

  withMemOptions(
    program.command("mem").description("attach 目标 Python 进程并把 PyHeap 文件回传到本机"),
  ).action(async (opts) => {
    await runCommand(
      { name: "doctor mem", environment: { kubernetes: true } },
      opts,
      (context) => runCollectMemory(opts, context),
    );
  });
  withMemaOptions(
    program.command("mema [inputs...]").description("在本机解析并诊断一个或多个 PyHeap 文件"),
  ).action(async (inputs, opts) => {
    await runCommand(
      { name: "doctor mema" },
      opts,
      (_context, profileName) => runCollectMemoryAnalysis({ ...opts, inputs, profileName }),
    );
  });
  withCpuOptions(
    program.command("cpu").description("对目标 pod 做 Python CPU/卡顿取证，产出证据包（无 server 直连）"),
  ).action(async (opts) => {
    await runCommand(
      { name: "doctor cpu", environment: { kubernetes: true } },
      opts,
      (context) => runCollectCpu(opts, context),
    );
  });
  withTraceOptions(
    program.command("trace").description("从 OpenSearch 下载 trace 全量 span，产出交互 node tree HTML 或证据包"),
  ).action(async (opts) => {
    await runPluginCommand(
      {
        name: "doctor trace",
        environment: { kubernetes: true },
        plugin: PLUGIN_COMMAND_CAPABILITIES.trace,
      },
      opts,
      plugin,
      (activePlugin, context) => runCollectTrace(opts, activePlugin, context),
    );
  });
  withStoreOptions(
    program.command("store").description("从 Service Pod 提取配置并诊断 DB/VDB/S3/Redis 健康与容量（只读）"),
  ).action(async (opts) => {
    await runPluginCommand(
      {
        name: "doctor store",
        environment: { kubernetes: true },
        plugin: PLUGIN_COMMAND_CAPABILITIES.store,
      },
      opts,
      plugin,
      (activePlugin, context) => runCollectStore(opts, activePlugin, context),
    );
  });
  withLogOptions(
    program.command("log").description("按业务 ID 解析 trace 并聚合各服务 pod 日志（只读，无 server 直连）"),
    "",
  ).action(async (opts) => {
    await runPluginCommand(
      {
        name: "doctor log",
        environment: { kubernetes: true },
        plugin: PLUGIN_COMMAND_CAPABILITIES.log,
      },
      opts,
      plugin,
      (activePlugin, context) => runCollectLog(opts, activePlugin, context),
    );
  });
  withDataOptions(
    program.command("data").description("先扩展业务 ID，再汇集 Service Catalog 声明的数据（由当前 Plugin 声明，只读）"),
    [],
  ).action(async (opts) => {
    await runPluginCommand(
      {
        name: "doctor data",
        environment: { kubernetes: true },
        plugin: PLUGIN_COMMAND_CAPABILITIES.data,
      },
      opts,
      plugin,
      (activePlugin, context) => runCollectData(
        opts,
        activePlugin,
        undefined,
        undefined,
        context,
      ),
    );
  });
  withConfigOptions(
    program.command("config").description("采集 Service 的 Pod 运行态，可选部署配置与 Plugin 租户配置（只读）"),
  ).action(async (opts) => {
    await runPluginCommand(
      {
        name: "doctor config",
        environment: { kubernetes: true },
        plugin: PLUGIN_COMMAND_CAPABILITIES.config,
      },
      opts,
      plugin,
      (activePlugin, context) => runCollectConfig(
        opts,
        activePlugin,
        undefined,
        undefined,
        undefined,
        context,
      ),
    );
  });
  withHttpOptions(
    program.command("http").description("从 YAML 重放一个或多个 HTTP 请求，执行多轮诊断并产出 Bundle、HTML 或 Markdown"),
  ).action(async (opts) => {
    await runCommand(
      { name: "doctor http" },
      opts,
      (context, profileName) => runCollectHttp(
        { ...opts, profileName },
        undefined,
        undefined,
        context,
      ),
      opts.example === undefined,
    );
  });
  withNetworkOptions(
    program.command("net").description("协调目标服务 Pod 短时抓包，以跟踪或守候模式产出 NetBundle"),
  ).action(async (opts) => {
    await runCommand(
      { name: "doctor net", environment: { kubernetes: true } },
      opts,
      (context) => runCollectNetwork(opts, context),
    );
  });
  program
    .command("neta [input]")
    .description("纯离线分析 NetBundle，重建业务调用并生成 Findings、Coverage 与可视化报告")
    .option("--trace-id <ids>", "逗号分隔的一个或多个 trace ID（缺省读取 NetBundle）")
    .option("--capture-id <id>", "覆盖 NetBundle 中的染色 ID")
    .option("-o, --output <path>", "报告输出路径或前缀；生成同名 Markdown、HTML 与 JSON")
    .action(async (input, opts) => {
      await runStandaloneCommand("doctor neta", () => runAnalyzeNetwork(input, opts));
    });
  withMcpOptions(
    program.command("mcp").description("对 MCP tool 执行多维取证与规则分析，产出 Evidence Bundle 或 HTML"),
  ).action(async (opts) => {
    await runPluginCommand(
      {
        name: "doctor mcp",
        environment: { kubernetes: true },
        plugin: PLUGIN_COMMAND_CAPABILITIES.mcp,
      },
      opts,
      plugin,
      (activePlugin, context) => runCollectMcp(opts, activePlugin, context),
    );
  });
  withModelOptions(
    program.command("model").description("从模型目录选择可用模型，执行 validation 与真实 inference"),
  ).action(async (opts) => {
    await runPluginCommand(
      {
        name: "doctor model",
        environment: { kubernetes: true },
        plugin: PLUGIN_COMMAND_CAPABILITIES.model,
      },
      opts,
      plugin,
      (activePlugin, context, profileName) => runCollectModel(
        { ...opts, profileName },
        activePlugin,
        context,
      ),
    );
  });
  withMetricOptions(
    program.command("metric").description("采集 Service 声明的 Prometheus metrics，执行 detector 并生成离线 HTML 图表"),
  ).action(async (opts) => {
    await runPluginCommand(
      {
        name: "doctor metric",
        plugin: PLUGIN_COMMAND_CAPABILITIES.metric,
      },
      opts,
      plugin,
      (activePlugin, context) => runCollectMetric(opts, activePlugin, context),
    );
  });

  if (process.argv.length === 2) {
    program.outputHelp();
    return;
  }
  await program.parseAsync(process.argv);
}

export function startDoctor(plugin?: PluginDefinition): void {
  main(plugin).catch((err) => {
    reportError(err, { context: "doctor main", summary: "fatal", displayMessage: mapErrorMessage(err) });
    process.exit(1);
  });
}
