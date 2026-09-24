import { CommandInputError, CommandStatus, aggregateCommandStatus, commandOutcome, type CommandResult } from "../../command";

import { useLogger } from "../../terminal/log";
// Trace run owns ID resolution, acquisition and persisted deterministic analysis.
// Render consumes that evidence; root Delivery owns the final files and their lifetime.
import type { PluginDefinition } from "@compforge/doctor-plugin";
import type { Executor, KubectlOptions } from "@compforge/harness-toolbox/kubernetes/executor";
import type { SearchEngine } from "@compforge/harness-toolbox/opensearch/types";
import type { TraceContributions } from "@compforge/trace-harness";
import { ConcurrencyPool } from "@compforge/harness-toolbox/concurrency";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOCTOR_CLI_VERSION } from "../../app/version";
import type { CommandContext } from "../../command";
import { resolveKubernetesCommandContext } from "../../command";
import {
  createKubernetesExecutor,
  resolveKubernetesCommandConfig,
  type KubernetesCommandConfig,
} from "../../command/kubernetes-target";
import {
  parseOpenSearchEndpoint,
  resolveOpenSearchAuth,
  type OpenSearchAuth,
} from "../../infra/search/opensearch";
import { resolvePluginTraceIds, type ResolvedPluginTraceId } from "../../plugin/trace-id";
import { resolvePluginTraceRange } from "../../plugin/trace-range";
import {
  enforceKubernetesAccess,
} from "../../terminal/kubernetes-access";
import { EvidenceBundle, type OutcomeDecl } from "../evidence";
import { evaluateCollectOutcome } from "../outcome";
import {
  confirmOpenSearchConnection,
  prepareOpenSearchAccess,
  type OpenSearchAccessPreparation,
} from "../shared/opensearch-access";
import {
  ServiceDependencyRuntime,
  openSearchDataSourceCandidates,
  type PreparedServiceDataSourceDependency,
  type ServiceDataSourceReference,
} from "../shared/service-dependency";
import { buildIndexExpr } from "./opensearch";
import { probeTrace } from "./probe";
import { buildTraceSummary } from "./render";
import { exportTraceSnapshot, TRACE_FILES } from "./snapshot";
import { resolveTraceWindow } from "./window";

export { accumulateStats, newTraceStats, type TraceStats } from "./probe";
export { buildTraceSummary } from "./render";

/** Plugin trace source is preferred; the remaining OpenSearch VDB capabilities are fallbacks. */
export function traceStoreCandidates(plugin: PluginDefinition): ServiceDataSourceReference[] {
  return openSearchDataSourceCandidates(plugin, plugin.trace?.source?.dataSource);
}

export interface CollectTraceCliOpts {
  /** 由 Plugin trace.resolve 解释的不透明 ID，可为业务 ID 或规范 trace ID。 */
  bizIds: readonly string[];
  from?: string;
  traceFile?: string;
  since?: string;
  sinceTime?: string;
  untilTime?: string;
  limit?: string;
  concurrency?: string;
  span?: string;
  node?: string;
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
  commandContext: CommandContext,
  needsOpenSearchKubernetes: boolean,
): Promise<TraceKubernetesRuntime | undefined> {
  const collect = await resolveKubernetesCommandConfig(opts, undefined, commandContext);
  if (!collect) return undefined;
  if (collect.kubernetes.kubeconfigSource.startsWith("profile:")) {
    useLogger("collect").info(`kubeconfig 来自 ${collect.kubernetes.kubeconfigSource}`
      + `（${collect.kubernetes.kubeconfig}）`);
  }
  useLogger("collect").info(`namespace: ${collect.kubernetes.namespace}（${collect.kubernetes.namespaceSource}）`);
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

export type TraceOutputFormat = "default" | "html" | "bundle";

export function parseTraceOutputFormat(value: string | undefined): TraceOutputFormat {
  const format = value?.trim() || "default";
  if (format !== "default" && format !== "html" && format !== "bundle") {
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
  plugin: PluginDefinition | undefined,
  commandContext: CommandContext,
): Promise<CommandResult<TraceOutput>> {
  const bizIds = [...new Set([
    ...(opts.bizIds ?? []),
  ].map((item) => item.trim()).filter(Boolean))];
  const rangeMode = opts.since !== undefined || opts.sinceTime !== undefined;
  const requestedIds = bizIds;
  const failure = (code: 2 | 130, reason: string): CommandResult<TraceOutput> => {
    const status = code === 130 ? CommandStatus.Cancelled : CommandStatus.Failed;
    return { status, reason, artifacts: [], error: code === 2 ? new CommandInputError(reason) : undefined,
      output: { items: requestedIds.map(bizId => ({
      bizId, traceIds: [], status, artifacts: [], reason,
    })) } };
  };
  if (!bizIds.length && !rangeMode) {
    useLogger().error("doctor trace 需要业务 ID、trace ID 或时间范围");
    return failure(2, "Trace 采集准备失败");
  }
  let window: { from: string; to: string } | undefined;
  try {
    if (rangeMode) window = resolveTraceWindow(opts);
  } catch (error) {
    return failure(2, error instanceof Error ? error.message : String(error));
  }
  const limit = Number(opts.limit ?? 50);
  const concurrency = Number(opts.concurrency ?? 2);
  if (!Number.isSafeInteger(limit) || limit <= 0 || !Number.isSafeInteger(concurrency) || concurrency <= 0) {
    return failure(2, "--limit 和 --concurrency 必须是正整数");
  }
  const pageSize = Number(opts.pageSize);
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    useLogger().error(`--page-size 需要正整数: '${opts.pageSize}'`);
    return failure(2, "Trace 采集准备失败");
  }
  try {
    parseTraceOutputFormat(opts.format);
  } catch (error) {
    useLogger().error(`${error instanceof Error ? error.message : String(error)}`);
    return failure(2, "Trace 采集准备失败");
  }
  const endpoint = opts.endpoint ?? opts.host ?? process.env.DOCTOR_OPENSEARCH_URL?.trim();
  let runtime: TraceKubernetesRuntime | undefined;
  try {
    runtime = await prepareTraceKubernetes(
      opts,
      commandContext,
      !endpoint && !plugin?.trace?.source?.dataSource,
    );
  } catch (err) {
    useLogger().error(`${err instanceof Error ? err.message : String(err)}`);
    return failure(2, "Trace 采集准备失败");
  }
  if (!runtime) {
    useLogger("collect").warn("已取消");
    return failure(130, "Trace 采集已取消");
  }

  const index = buildIndexExpr(opts.index, opts.indexDate);
  const dependencyRuntime = runtime && plugin ? new ServiceDependencyRuntime({
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
      if (tone === "warning") useLogger().warn(`${line}`);
      else useLogger().info(`${line}`);
    },
  }) : undefined;

  try {
  let traces: ResolvedPluginTraceId[];
  let truncated: { reason: string } | undefined;
  try {
    if (window) {
      const resolved = await resolvePluginTraceRange({
        window, limit,
        kube: runtime!.collect.kubernetes,
        commandContext,
        resolveDependencies: service => dependencyRuntime!.resolve(service),
      }, plugin!, runtime!.executor);
      traces = resolved.traces;
      truncated = resolved.truncated;
    } else {
      traces = await resolvePluginTraceIds({
      bizIds,
      namespace: runtime!.collect.kubernetes.namespace,
      kubeconfig: runtime!.collect.kubernetes.kubeconfig,
      context: runtime!.collect.kubernetes.context,
      profileName: commandContext.profile.name,
      command: "doctor trace",
      commandContext,
      resolveDependencies: (service) => dependencyRuntime!.resolve(service),
      }, plugin!, runtime!.executor);
    }
  } catch (err) {
    useLogger().error(`${err instanceof Error ? err.message : String(err)}`);
    return failure(2, "Trace 采集准备失败");
  }
  const sources = traces.map(trace => ({
    trace_id: trace.traceId, source_id: trace.sourceId, service: trace.service, resolved_as: trace.resolvedAs,
  }));
  if (window) {
    const seen = new Set<string>();
    traces = traces.filter(trace => {
      if (seen.has(trace.traceId)) return false;
      seen.add(trace.traceId);
      return true;
    });
  }
  for (const trace of traces) {
    useLogger("collect").info(`input-id: ${trace.bizId} → trace-id: ${trace.traceId}`
      + `（${trace.service} 按 ${trace.resolvedAs} 解析`
      + `${trace.sourceId ? `，source=${trace.sourceId}` : ""}）`);
  }

  if (opts.span && new Set(traces.map(trace => trace.traceId)).size > 1) {
    return failure(2, "--span 的业务 ID 解析出多条 trace；请改用明确的 trace ID 再查询，不能仅凭 span ID 选择 trace");
  }

  const bundleName = defaultTraceBatchName(new Date());
  const stagingRoot = mkdtempSync(join(tmpdir(), "doctor-collect-"));
  const staging = join(stagingRoot, bundleName);
  const summary = commandContext.artifacts.add({ command: "trace", path: staging });
  const bundle = new EvidenceBundle(staging);
  const startedAt = new Date().toISOString();
  const rootMeta = {
    doctorVersion: DOCTOR_CLI_VERSION,
    target: { namespace: runtime?.collect.kubernetes.namespace, input_ids: bizIds,
      trace_ids: traces.map(trace => trace.traceId), sources, ...(window ? { window } : {}) },
    inspectionFacts: {},
    params: { index, page_size: pageSize, selection: window ? "time_range" : "biz_id",
      pagination_consistency: "live", concurrency, ...(window ? { limit, truncated } : {}) },
    startedAt,
  };
  // The target list is evidence even if the Store cannot be reached or collection is cancelled.
  bundle.writeCollection({ ...rootMeta, finishedAt: new Date().toISOString() });
  bundle.writeSummary([
    "# trace 目标选择", "",
    `- 来源: ${window ? "时间范围" : "业务 ID 或 trace ID"}`,
    ...(window ? [`- 时间范围: ${window.from} → ${window.to}`, `- limit: ${limit}`] : []),
    `- 选中 trace 数: ${traces.length}`,
    ...(truncated ? [`- 选择已截断: ${truncated.reason}`] : []),
    "",
  ].join("\n"));
  const selection = { window, limit: window ? limit : undefined, truncated };
  const preparationFailure = (reason: string): CommandResult<TraceOutput> => ({
    status: CommandStatus.Failed, reason, artifacts: [summary],
    output: { items: [{ bizId: window ? "time_range" : "trace", traceIds: traces.map(trace => trace.traceId),
      status: CommandStatus.Failed, artifacts: [], reason }], selection },
  });
  if (!traces.length) {
    const reason = window ? "时间范围内没有可采集的 trace_id" : "输入 ID 未解析到可采集的 trace_id";
    useLogger("collect").warn(`${reason}（${window
      ? `window=${window.from}..${window.to}，limit=${limit}`
      : `输入 ID 数=${bizIds.length}`}）`);
    return preparationFailure(reason);
  }

  const traceStores = plugin ? traceStoreCandidates(plugin) : [];
  let preparedStore: PreparedServiceDataSourceDependency | undefined;
  if (traceStores.length && dependencyRuntime) {
    try {
      preparedStore = endpoint
        ? await dependencyRuntime.prepareDataSource(traceStores[0]!.service, traceStores[0]!.dataSource)
        : await dependencyRuntime.prepareDataSourceCandidates(traceStores);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      useLogger().error(reason);
      return preparationFailure(`OpenSearch Store 准备失败：${reason}`);
    }
  }

  // trace-harness 仅在实际执行 trace 时加载，避免拖慢其它 doctor 命令的启动。
  const { genAiSpecs, mergeTraceContributions } = await import("@compforge/trace-harness");
  const explicitAuth = resolveOpenSearchAuth(opts.username, opts.password);
  const kube: KubectlOptions | undefined = runtime
    ? {
        kubeconfig: runtime.collect.kubernetes.kubeconfig,
        context: runtime.collect.kubernetes.context,
        namespace: runtime.collect.kubernetes.namespace,
      }
    : undefined;
  const pluginSpecs = [...(plugin?.trace?.analysis.specs ?? [])];
  const overriddenKinds = new Set(pluginSpecs.map((spec) => spec.kind));
  // A kind has one projection owner; appending a second spec silently discards the
  // Plugin projection and its required facts during assembly.
  const contributions = mergeTraceContributions(
    { ...plugin?.trace?.analysis, specs: pluginSpecs },
    { specs: [...genAiSpecs()].filter((spec) => !overriddenKinds.has(spec.kind)) },
  );
  const groupIds = bizIds.length ? bizIds : traces.map(trace => trace.bizId);
  const tasks = groupIds.flatMap((bizId, bizIndex) => traces.filter(trace => trace.bizId === bizId)
    .map((trace, traceIndex) => {
      const outputDir = join(stagingRoot, `${bundleName}-biz-${bizIndex + 1}-trace-${traceIndex + 1}`);
      return { bizId, trace, outputDir };
    }));
  const pool = new ConcurrencyPool(concurrency);
  const results = await Promise.allSettled(tasks.map(task => pool.run(async () => {
    useLogger("collect:trace").info(`trace-id: ${task.trace.traceId}`);
    const artifact = commandContext.artifacts.add({ command: "trace", path: task.outputDir });
    try {
      const code = await collectTrace({
        traceId: task.trace.traceId,
        spanId: opts.span,
        contributions,
        bizId: task.bizId,
        index,
        auth: preparedStore?.auth ?? explicitAuth,
        endpoint,
        configuredEndpoint: preparedStore?.configuredEndpoint,
        service: opts.service,
        kube,
        pageSize,
        signal: commandContext.signal,
        outputDir: task.outputDir,
        preparedStore,
        traceIdResolution: {
          service: task.trace.service,
          resolvedAs: task.trace.resolvedAs,
          sourceId: task.trace.sourceId,
        },
        selectionMode: window ? "time_range" : task.trace.resolvedAs === "trace_id" ? "trace_id" : "biz_id",
      }, (line, tone) => {
        if (tone === "warning") useLogger().warn(`${line}`);
        else useLogger().info(`${line}`);
      });
      return { code, artifact };
    } catch (error) {
      useLogger("collect").error(`trace ${task.trace.traceId} 采集失败：${error instanceof Error ? error.message : String(error)}`);
      return { code: 1, artifact };
    }
  }, commandContext.signal)));
  const items: TraceOutput["items"][number][] = groupIds.map(bizId => {
    const indexes = tasks.flatMap((task, index) => task.bizId === bizId ? [index] : []);
    const artifactIndexes = indexes.filter(index => results[index]!.status === "fulfilled"
      && existsSync(join(tasks[index]!.outputDir, "collection.json")));
    const itemStatuses = indexes.map(index => {
      const result = results[index]!;
      if (commandContext.signal.aborted) return CommandStatus.Cancelled;
      return result.status === "fulfilled" ? commandOutcome(result.value.code).status : CommandStatus.Failed;
    });
    return { bizId,
      traceIds: indexes.map(index => tasks[index]!.trace.traceId),
      artifactTraceIds: artifactIndexes.map(index => tasks[index]!.trace.traceId),
      status: itemStatuses.length ? aggregateCommandStatus(itemStatuses) : CommandStatus.Failed,
      artifacts: artifactIndexes.map(index => {
        const result = results[index]!;
        if (result.status !== "fulfilled") throw new Error("Trace artifact status changed");
        return result.value.artifact;
      }),
      ...(!indexes.length ? { reason: "本地目标列表没有可采集的 trace_id" } : {}),
    };
  });
  if (!items.length) items.push({ bizId: "time_range", traceIds: [], status: CommandStatus.Failed,
    artifacts: [], reason: "时间范围内没有可采集的 trace_id" });
  bundle.writeCollection({ ...rootMeta, finishedAt: new Date().toISOString() });
  writeFileSync(join(staging, "diagnosis.json"), JSON.stringify({ items: items.map(({ artifacts, ...item }) => ({
    ...item, artifact_ids: artifacts.map(artifact => artifact.id),
  })) }, null, 2));
  const status = aggregateCommandStatus(items.map(item => item.status));
  return { status: status === CommandStatus.Ok && truncated ? CommandStatus.Partial : status,
    output: { items, contributions, selection },
    artifacts: [summary, ...items.flatMap(item => item.artifacts)] };
  } finally {
    try {
      await dependencyRuntime?.close();
    } catch (error) {
      useLogger("collect").warn(`Service capability 依赖清理失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export interface TraceCollectOptions {
  /** 已由 Plugin traceId capability 解析的规范 trace_id。 */
  traceId: string;
  spanId?: string;
  contributions?: TraceContributions;
  bizId: string;
  traceIdResolution: {
    service: string;
    resolvedAs: string;
    sourceId?: string;
  };
  selectionMode?: "time_range" | "trace_id" | "biz_id";
  index: string;
  auth: OpenSearchAuth;
  /** Doctor Host 直连地址（--endpoint / DOCTOR_OPENSEARCH_URL）；给了就不走 kubectl。 */
  endpoint?: string;
  /** 从业务 Service Store 运行时配置中提取的 OpenSearch 地址。 */
  configuredEndpoint?: string;
  service?: string;
  kube?: KubectlOptions;
  pageSize: number;
  signal?: AbortSignal;
  outputDir: string;
  /** Shared dependency access owned by the outer batch command. */
  preparedStore?: PreparedServiceDataSourceDependency;
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
  { id: "resolve-id", title: "trace_id 目标确认", risk: "observe" },
  { id: "count", title: "span 总数查询", risk: "observe" },
  { id: "download", title: "所选范围的 span 下载", risk: "observe" },
  { id: "analysis", title: "离线 tree / node 证据投影", risk: "observe" },
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
  let exported = false;

  const finish = async (code: number, target: Record<string, unknown> = {}) => {
    if (ownsPreparation) await preparation?.close();
    bundle.writeCollection({
      doctorVersion: DOCTOR_CLI_VERSION,
      target: { ...confirmedTarget, input_id: opts.bizId, trace_id: traceId, span_id: opts.spanId,
        scope: opts.spanId ? "span" : "trace", index: opts.index,
        resolved_as: opts.traceIdResolution.resolvedAs, source_id: opts.traceIdResolution.sourceId, ...target },
      files: exported ? TRACE_FILES : existsSync(join(opts.outputDir, "spans.jsonl")) ? { spans: TRACE_FILES.spans } : undefined,
      inspectionFacts: {},
      params: {
        index: opts.index,
        page_size: opts.pageSize,
        pagination_consistency: "live",
        span_id: opts.spanId,
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
    spanId: opts.spanId,
    index: opts.index,
    pageSize: opts.pageSize,
    signal: opts.signal,
    outputDir: opts.outputDir,
  }, bundle, log);
  // Even interrupted downloads keep a usable local index; incompleteness must remain visible.
  if (existsSync(join(opts.outputDir, "spans.jsonl"))) {
    try {
      await exportTraceSnapshot(opts.outputDir, traceId, {
        scope: opts.spanId ? "span" : "trace", span_id: opts.spanId, complete: probe.ok && probe.complete,
      }, opts.contributions);
      exported = true;
      bundle.fill("analysis", { status: "ok" });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      bundle.fill("analysis", { status: "failed", reason });
      log(`[collect] 原始 spans 已保留，tree 投影失败：${reason}`, "warning");
    }
  }
  if (!probe.ok) {
    failSummary(probe.title, probe.reason);
    return finish(1);
  }

  bundle.writeSummary(
    buildTraceSummary({
      traceId,
      inputId: opts.bizId,
      selectionMode: opts.selectionMode,
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
  return finish(evaluateCollectOutcome([probe.complete && exported ? "sufficient" : "insufficient"]).exitCode,
    { ...confirmedTarget, base_url: baseUrl });
}

export interface TraceOutput {
  readonly contributions?: TraceContributions;
  readonly selection?: { window?: { from: string; to: string }; limit?: number; truncated?: { reason: string } };
  readonly items: readonly { bizId: string; traceIds: readonly string[]; artifactTraceIds?: readonly string[];
    status: CommandStatus; reason?: string;
    artifacts: readonly import("../../command").CommandArtifact[] }[];
}
