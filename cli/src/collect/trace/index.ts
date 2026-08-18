import { terminalStdout, terminalStderr } from "../../terminal/output";
// trace 采集编排：通道解析（--endpoint 直连 / DOCTOR_OPENSEARCH_URL / kubectl 发现 svc +
// port-forward）→ _count 验证 → search_after 全量下载 → spans.jsonl → HTML / 证据包。
// 采集全程确定性只读；下载协议语义在 opensearch.ts，本文件只做编排、统计、渲染与交付。
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { PluginDefinition } from "@compforge/doctor-plugin";
import type { TraceContributions } from "@compforge/trace-harness";
import { DOCTOR_CLI_VERSION } from "../../app/version";
import { resolveWorkingProfileName } from "../../app/profile";
import {
  createKubernetesExecutor,
  resolveKubernetesCommandConfig,
  type KubernetesCommandConfig,
} from "../../command/kubernetes-target";
import type { Executor, KubectlOptions } from "../../infra/k8s/executor";
import type { SearchEngine } from "../../infra/search";
import {
  parseOpenSearchEndpoint,
  resolveOpenSearchAuth,
  type OpenSearchAuth,
} from "../../infra/search/opensearch";
import { EvidenceBundle, type OutcomeDecl } from "../evidence";
import { resolveKubernetesCommandContext } from "../../command";
import type { CommandContext } from "../../command";
import { packBundle, resolveArchivePath } from "../output/archive";
import {
  failedReportHtml,
  type ReportLeafTab,
  type ReportTab,
  writeTabbedReport,
} from "../output/tabbed-report";
import { evaluateCollectOutcome } from "../outcome";
import {
  enforceKubernetesAccess,
} from "../../terminal/kubernetes-access";
import { resolvePluginTraceIds } from "../../plugin/trace-id";
import {
  confirmOpenSearchConnection,
  prepareOpenSearchAccess,
  type OpenSearchAccessPreparation,
} from "../shared/opensearch-access";
import {
  ServiceDependencyRuntime,
  type PreparedServiceStoreDependency,
} from "../shared/service-dependency";
import { buildIndexExpr } from "./opensearch";
import { probeTrace } from "./probe";
import { buildTraceSummary } from "./render";

export { accumulateStats, newTraceStats, type TraceStats } from "./probe";
export { buildTraceSummary } from "./render";

export interface CollectTraceCliOpts {
  /** 由 Plugin traceId capability 分别解析为一个或多个 trace_id 的业务 ID。 */
  bizIds?: string[];
  /** @deprecated Use bizIds. */
  bizId?: string;
  namespace?: string;
  service?: string;
  endpoint?: string;
  /** @deprecated 使用 endpoint；仅保留 CLI 兼容。 */
  host?: string;
  index?: string;
  indexDate?: string;
  username?: string;
  password?: string;
  pageSize: string;
  format?: string;
  kubeconfig?: string;
  context?: string;
  profile?: string;
  config?: string;
  output?: string;
}

interface TraceKubernetesRuntime {
  collect: KubernetesCommandConfig;
  executor: Executor;
}

async function prepareTraceKubernetes(
  opts: CollectTraceCliOpts,
  commandContext: CommandContext | undefined,
  needsOpenSearchKubernetes: boolean,
): Promise<TraceKubernetesRuntime | undefined> {
  const collect = await resolveKubernetesCommandConfig(opts, undefined, commandContext);
  if (!collect) return undefined;
  if (collect.kubernetes.kubeconfigSource.startsWith("profile:")) {
    terminalStdout.write(
      `[collect] kubeconfig 来自 ${collect.kubernetes.kubeconfigSource}`
      + `（${collect.kubernetes.kubeconfig}）\n`,
    );
  }
  terminalStdout.write(
    `[collect] namespace: ${collect.kubernetes.namespace}（${collect.kubernetes.namespaceSource}）\n`,
  );
  const executor = createKubernetesExecutor(collect);
  await enforceKubernetesAccess(resolveKubernetesCommandContext(executor, commandContext).access, {
    command: "doctor trace",
    needs: needsOpenSearchKubernetes ? [
      {
        requirement: "required",
        rule: { verb: "list", resource: "services" },
        purpose: "定位 OpenSearch 配置来源 Service",
      },
      {
        requirement: "required",
        rule: { verb: "list", resource: "pods" },
        purpose: "定位 OpenSearch 配置来源 Pod",
      },
      {
        requirement: "preferred",
        rule: { verb: "get", resource: "configmaps" },
        purpose: "读取 OpenSearch 配置",
        fallback: "回退读取 Container 运行时配置",
      }, {
        requirement: "preferred",
        rule: { verb: "get", resource: "secrets" },
        purpose: "读取 OpenSearch 凭据",
        fallback: "回退读取 Container 运行时配置",
      }, {
        requirement: "preferred",
        rule: { verb: "create", resource: "pods/exec" },
        purpose: "声明配置不足时读取 Container 运行时 env",
        fallback: "配置不足时回退自动发现 OpenSearch",
      },
      {
        requirement: "required",
        rule: { verb: "create", resource: "pods/portforward" },
        purpose: "访问集群内 OpenSearch",
      },
    ] : [],
  });
  return { collect, executor };
}

export function defaultTraceBundleName(traceId: string, now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `doctor-trace-${traceId.slice(0, 12)}-${ts}`;
}

export function defaultTraceBatchName(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `doctor-trace-batch-${ts}`;
}

export type TraceOutputFormat = "html" | "bundle";

export function parseTraceOutputFormat(value: string | undefined): TraceOutputFormat {
  const format = value?.trim() || "html";
  if (format !== "html" && format !== "bundle") {
    throw new Error(`--format 只支持 html 或 bundle: '${format}'`);
  }
  return format;
}

export function resolveTraceHtmlPath(output: string | undefined, reportName: string): string {
  if (!output) return join(".", `${reportName}.html`);
  if (/\.(?:tar\.gz|tgz)$/i.test(output)) throw new Error("--format html 的输出路径不能使用 .tar.gz/.tgz 后缀");
  return output.toLowerCase().endsWith(".html") ? output : `${output}.html`;
}

function safeOpenSearchEndpoint(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return parseOpenSearchEndpoint(value).safeUrl;
  } catch {
    return undefined;
  }
}

/** commander action 入口：参数校验 + 组装通道，核心流程在 collectTrace（可注入 SearchEngine 测试） */
export async function runCollectTrace(
  opts: CollectTraceCliOpts,
  plugin: PluginDefinition,
  commandContext?: CommandContext,
): Promise<number> {
  const bizIds = [...new Set([
    ...(opts.bizIds ?? []),
    ...(opts.bizId ? [opts.bizId] : []),
  ].map((item) => item.trim()).filter(Boolean))];
  if (!bizIds.length) {
    terminalStderr.error("doctor trace 需要至少一个 biz-id\n");
    return 2;
  }
  const pageSize = Number(opts.pageSize);
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    terminalStderr.error(`--page-size 需要正整数: '${opts.pageSize}'\n`);
    return 2;
  }
  let format: TraceOutputFormat;
  try {
    format = parseTraceOutputFormat(opts.format);
  } catch (error) {
    terminalStderr.error(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const endpoint = opts.endpoint ?? opts.host ?? process.env.DOCTOR_OPENSEARCH_URL?.trim();
  let runtime: TraceKubernetesRuntime | undefined;
  try {
    runtime = await prepareTraceKubernetes(
      opts,
      commandContext,
      !endpoint && !plugin.trace?.source?.store,
    );
  } catch (err) {
    terminalStderr.error(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  if (!runtime) {
    terminalStderr.warning("[collect] 已取消\n");
    return 130;
  }

  const index = buildIndexExpr(opts.index, opts.indexDate);
  const dependencyRuntime = new ServiceDependencyRuntime({
    plugin,
    collect: runtime.collect,
    executor: runtime.executor,
    command: "doctor trace",
    commandContext,
    index,
    endpoint,
    serviceName: opts.service,
    username: opts.username,
    password: opts.password,
    log: (line, tone) => {
      if (tone === "warning") terminalStdout.warning(`${line}\n`);
      else terminalStdout.write(`${line}\n`);
    },
  });

  try {
  let traces;
  try {
    traces = await resolvePluginTraceIds({
      bizIds,
      namespace: runtime.collect.kubernetes.namespace,
      kubeconfig: runtime.collect.kubernetes.kubeconfig,
      context: runtime.collect.kubernetes.context,
      profileName: commandContext?.profile.name ?? resolveWorkingProfileName(opts),
      command: "doctor trace",
      commandContext,
      resolveDependencies: (service) => dependencyRuntime.resolve(service),
    }, plugin, runtime.executor);
  } catch (err) {
    terminalStderr.error(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  for (const trace of traces) {
    terminalStdout.write(
      `[collect] biz-id: ${trace.bizId} → trace-id: ${trace.traceId}`
      + `（${trace.service} 按 ${trace.resolvedAs} 解析`
      + `${trace.sourceId ? `，source=${trace.sourceId}` : ""}）\n`,
    );
  }

  const traceStore = plugin.trace?.source?.store;
  let preparedStore: PreparedServiceStoreDependency | undefined;
  if (traceStore) {
    try {
      preparedStore = await dependencyRuntime.prepareStore(traceStore.service, traceStore.store);
    } catch (error) {
      terminalStderr.error(`${error instanceof Error ? error.message : String(error)}\n`);
      return 2;
    }
  }

  const singleTrace = bizIds.length === 1 && traces.length === 1;
  const bundleName = singleTrace
    ? defaultTraceBundleName(traces[0]!.traceId, new Date())
    : defaultTraceBatchName(new Date());
  let outputPath: string;
  try {
    outputPath = format === "html"
      ? resolveTraceHtmlPath(opts.output, bundleName)
      : resolveArchivePath(opts.output, bundleName);
  } catch (error) {
    terminalStderr.error(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  // trace-harness 仅在实际执行 trace 时加载，避免拖慢其它 doctor 命令的启动。
  const { genAiSpecs, mergeTraceContributions } = await import("@compforge/trace-harness");
  const stagingRoot = mkdtempSync(join(tmpdir(), "doctor-collect-"));
  const staging = join(stagingRoot, bundleName);
  const explicitAuth = resolveOpenSearchAuth(opts.username, opts.password);
  const kube: KubectlOptions | undefined = runtime
    ? {
        kubeconfig: runtime.collect.kubernetes.kubeconfig,
        context: runtime.collect.kubernetes.context,
        namespace: runtime.collect.kubernetes.namespace,
      }
    : undefined;
  const contributions = plugin.trace
    ? mergeTraceContributions(plugin.trace.analysis, { specs: genAiSpecs() })
    : { specs: genAiSpecs() };
  const groups: ReportTab[] = [];
  let exitCode = 0;
  for (const [bizIndex, bizId] of bizIds.entries()) {
    const groupTraces = traces.filter((trace) => trace.bizId === bizId);
    const groupKey = `biz-${bizIndex + 1}`;
    const traceTabs: ReportLeafTab[] = [];
    let groupCode = 0;
    for (const [traceIndex, trace] of groupTraces.entries()) {
      const outputDir = singleTrace
        ? staging
        : join(staging, `biz-${bizIndex + 1}`, `trace-${traceIndex + 1}-${trace.traceId.slice(0, 12)}`);
      let code;
      try {
        code = await collectTrace(
          {
            traceId: trace.traceId,
            bizId,
            index,
            auth: preparedStore?.auth ?? explicitAuth,
            endpoint,
            configuredEndpoint: preparedStore?.configuredEndpoint,
            service: opts.service,
            kube,
            pageSize,
            outputDir,
            contributions,
            preparedStore,
            traceIdResolution: {
              service: trace.service,
              resolvedAs: trace.resolvedAs,
              sourceId: trace.sourceId,
            },
          },
          (line, tone) => {
            if (tone === "warning") terminalStdout.warning(`${line}\n`);
            else terminalStdout.write(`${line}\n`);
          },
        );
      } catch (error) {
        code = 1;
        terminalStderr.error(
          `[collect] trace ${trace.traceId} 采集失败：${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
      traceTabs.push({
        key: `${groupKey}-trace-${traceIndex + 1}`,
        label: trace.sourceId ? `${trace.sourceId} · ${trace.traceId}` : trace.traceId,
        status: code === 0 ? "delivered" as const : "failed" as const,
        html: code === 0
          ? readFileSync(join(outputDir, "trace.html"), "utf8")
          : failedReportHtml(`Trace 采集失败：${trace.traceId}`, `Biz ID ${bizId}，退出码 ${code}`),
      });
      groupCode = Math.max(groupCode, code);
    }
    const group = {
      key: groupKey,
      label: bizId,
      status: groupCode === 0 ? "delivered" as const : "failed" as const,
    };
    // 保留 Biz -> Trace 的导航数据，由最外层报告统一渲染；这里嵌套报告壳会重复标题、页签和 iframe。
    groups.push(traceTabs.length === 1
      ? { ...group, html: traceTabs[0]!.html }
      : { ...group, tabs: traceTabs });
    exitCode = Math.max(exitCode, groupCode);
  }

  if (format === "html") {
    if (singleTrace && exitCode === 0) copyFileSync(join(staging, "trace.html"), resolve(outputPath));
    else {
      writeTabbedReport(outputPath, {
        title: "doctor Trace 诊断报告",
        description: "同一批次采集，每个 Biz ID 独立分组",
        ariaLabel: "Biz ID Trace 诊断结果",
        tabs: groups,
      });
    }
    if (exitCode === 0) rmSync(stagingRoot, { recursive: true, force: true });
    else terminalStderr.warning(`[collect] 失败 Trace 证据保留在目录: ${staging}\n`);
    terminalStdout.result(exitCode === 0, `[collect] Trace HTML 报告: ${outputPath}\n`);
    return exitCode;
  }

  const packed = await packBundle(staging, outputPath);
  if (!packed.ok) {
    terminalStderr.error(`[collect] 打包失败（${packed.stderr.trim().split("\n")[0]}），证据保留在目录: ${staging}\n`);
    return 1;
  }
  rmSync(stagingRoot, { recursive: true, force: true });
  terminalStdout.result(exitCode === 0, `[collect] Trace 证据包: ${outputPath}\n`);
  return exitCode;
  } finally {
    try {
      await dependencyRuntime.close();
    } catch (error) {
      terminalStdout.warning(
        `[collect] Service capability 依赖清理失败：${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
}

export interface TraceCollectOptions {
  /** 已由 Plugin traceId capability 解析的规范 trace_id。 */
  traceId: string;
  bizId: string;
  traceIdResolution: {
    service: string;
    resolvedAs: string;
    sourceId?: string;
  };
  index: string;
  auth: OpenSearchAuth;
  /** Doctor Host 直连地址（--endpoint / DOCTOR_OPENSEARCH_URL）；给了就不走 kubectl。 */
  endpoint?: string;
  /** 从业务 Service Store 运行时配置中提取的 OpenSearch 地址。 */
  configuredEndpoint?: string;
  service?: string;
  kube?: KubectlOptions;
  pageSize: number;
  outputDir: string;
  contributions?: TraceContributions;
  /** Shared dependency access owned by the outer batch command. */
  preparedStore?: PreparedServiceStoreDependency;
}

/**
 * 本次采集打算拿到的证据（检验项）。Plugin 是否解析出 trace_id 在进入本函数前已确认；
 * 这里记录解析结果，并检查 OpenSearch 是否可达、目标 trace 是否有 span。
 * 通道相关的 channel /
 * svc-discovery / port-forward / probe-scheme 是**工序**（怎么够到 OpenSearch），走
 * addStep 追加。
 *
 * 预印在这里，是为了让"没做"和"没记"长得不一样：早退路径（svc 定位失败、
 * port-forward 起不来、OpenSearch 不可达、count 失败、span 数为 0）
 * 都只写 summary.md，manifest 里下游几行直接消失——而 manifest 才是机器消费的那份。
 */
const TRACE_OUTCOMES: readonly OutcomeDecl[] = [
  { id: "resolve-id", title: "业务 ID 到 trace_id 的 Plugin 解析", risk: "observe" },
  { id: "count", title: "span 总数查询", risk: "observe" },
  { id: "download", title: "span 全量下载", risk: "observe" },
  { id: "render-html", title: "交互 node tree HTML", risk: "observe" },
];

export async function collectTrace(
  opts: TraceCollectOptions,
  log: (line: string, tone?: "info" | "warning") => void,
  injectedSearch?: SearchEngine,
): Promise<number> {
  const startedAt = new Date().toISOString();
  const bundle = new EvidenceBundle(opts.outputDir, TRACE_OUTCOMES);
  let preparation: OpenSearchAccessPreparation | undefined;
  let ownsPreparation = false;
  let search: SearchEngine | undefined;
  let channel = "";
  let confirmedTarget: Record<string, unknown> = {};
  const traceId = opts.traceId;

  const finish = async (code: number, target: Record<string, unknown> = {}) => {
    if (ownsPreparation) await preparation?.close();
    bundle.writeManifest({
      doctorVersion: DOCTOR_CLI_VERSION,
      target: { input_id: opts.bizId, trace_id: traceId, index: opts.index, ...target },
      inspectionFacts: {},
      params: {
        index: opts.index,
        page_size: opts.pageSize,
        endpoint: safeOpenSearchEndpoint(opts.endpoint),
        configured_endpoint: safeOpenSearchEndpoint(opts.configuredEndpoint),
        service: opts.service,
        namespace: opts.kube?.namespace,
        // 凭据只记录 username（是否配置了鉴权本身是排障线索）；password 永不落盘
        username: opts.auth.username,
      },
      startedAt,
      finishedAt: new Date().toISOString(),
    });
    return code;
  };
  const failSummary = (title: string, reason: string) => {
    bundle.writeSummary(`# trace 采集失败\n\n${title}：${reason}\n`);
    // 早退时把单子上还空着的检验项一并交代掉。所有早退点都经过这里，且此刻 reason
    // 最准——比 writeManifest 兜底的"未到达"强。以前这里只写 summary.md（给人看），
    // manifest.json（给机器看）里下游几行就凭空消失了。
    bundle.settle(`${title}：${reason}`);
  };

  bundle.fill("resolve-id", {
    status: "ok",
    output: JSON.stringify({
      biz_id: opts.bizId,
      trace_id: traceId,
      service: opts.traceIdResolution.service,
      resolved_as: opts.traceIdResolution.resolvedAs,
      source_id: opts.traceIdResolution.sourceId,
    }),
    ext: "json",
  });

  if (!opts.auth.username) {
    log("[collect] 未提供 OpenSearch 凭据（--username/--password 或 DOCTOR_OPENSEARCH_USERNAME/PASSWORD），按匿名访问尝试");
  }

  if (opts.preparedStore) {
    preparation = opts.preparedStore.preparation;
    confirmedTarget = opts.preparedStore.evidenceTarget;
    for (const step of opts.preparedStore.steps) bundle.addStep(step);
  } else {
    const confirmation = await confirmOpenSearchConnection({
      endpoint: opts.endpoint,
      configuredEndpoint: opts.configuredEndpoint,
      serviceName: opts.service,
      kube: opts.kube,
    }, log);
    for (const step of confirmation.steps) bundle.addStep(step);
    confirmedTarget = confirmation.evidenceTarget ?? {};
    if (confirmation.failure) {
      failSummary(confirmation.failure.title, confirmation.failure.reason);
      return finish(1, confirmedTarget);
    }

    // 网络准备统一拥有 Search client 与 port-forward，主链从此只消费准备好的 SearchEngine。
    preparation = await prepareOpenSearchAccess({
      connection: confirmation.connection,
      kube: opts.kube,
      auth: opts.auth,
    }, log, injectedSearch);
    ownsPreparation = true;
    for (const step of preparation.steps) bundle.addStep(step);
  }
  if (preparation.failure || !preparation.search || !preparation.baseUrl || !preparation.channel) {
    const failure = preparation.failure ?? { title: "OpenSearch 准备失败", reason: "访问通道不完整" };
    log(`[collect] ${failure.reason}`);
    failSummary(failure.title, failure.reason);
    return finish(1, { ...confirmedTarget, ...preparation.evidenceTarget });
  }
  search = preparation.search;
  channel = preparation.channel;
  const baseUrl = preparation.baseUrl;

  const probe = await probeTrace(search, {
    traceId,
    index: opts.index,
    pageSize: opts.pageSize,
    outputDir: opts.outputDir,
  }, bundle, log);
  if (!probe.ok) {
    failSummary(probe.title, probe.reason);
    return finish(1);
  }

  try {
    const {
      genAiSpecs,
      normalizeJaegerSpans,
      TraceHarness,
    } = await import("@compforge/trace-harness");
    const spanDocuments = readFileSync(join(opts.outputDir, "spans.jsonl"), "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const harness = new TraceHarness(opts.contributions ?? { specs: genAiSpecs() });
    const context = harness.assemble(normalizeJaegerSpans(spanDocuments));
    writeFileSync(
      join(opts.outputDir, "trace.html"),
      harness.renderInteractive(context, harness.diagnose(context)),
      "utf-8",
    );
    bundle.fill("render-html", { status: "ok" });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    bundle.fill("render-html", { status: "failed", reason });
    log(`[collect] trace HTML 渲染失败：${reason}`);
    failSummary("trace HTML 渲染失败", reason);
    return finish(1);
  }

  bundle.writeSummary(
    buildTraceSummary({
      traceId,
      inputId: opts.bizId,
      resolvedAs: opts.traceIdResolution.resolvedAs,
      index: opts.index,
      channel,
      count: probe.count,
      downloaded: probe.downloaded,
      stats: probe.stats,
      steps: bundle.getSteps().map((s) => `| ${s.id} | ${s.status} | ${s.reason ?? ""} |`),
    }),
  );
  log(`[collect] 完成（${probe.downloaded}/${probe.count} span）。`);
  return finish(evaluateCollectOutcome([probe.complete]).exitCode, { ...confirmedTarget, base_url: baseUrl });
}
