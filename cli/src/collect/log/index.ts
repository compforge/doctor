import { factsLogWindows, type DataLogWindows } from "./data-window";
import { timePaddingMs, selectLogTimeWindow, resolveLogTimeWindow, validateLogTimeWindow, type TraceLogWindow } from "./window";
import { resolveLogWorkloads, mergeLogWorkloads } from "./workloads";
import { gapMessages } from "../evidence-gaps";
import { collectLogAssociations } from "./association";
import { projectDataFacts } from "../data/projection";
import { detectDataEvidenceGaps } from "../data/detector";
import { logIdentities, logKeys } from "./correlation";
import type { KubernetesPodLogAccess } from "@compforge/harness-toolbox/kubernetes/pod-log";
import { CommandStatus, aggregateCommandStatus, commandOutcome, type CommandResult } from "../../command";

import { useLogger } from "../../terminal/log";
// Log run resolves IDs and captures shared Pod evidence; report renders each item during root finalize.
// Kubernetes 的 Pod 枚举和日志读取由 Toolkit 提供；本目录只保留业务选择和证据语义。
import { type PluginDefinition } from "@compforge/doctor-plugin";
import { ClientNodePodLogAccess } from "@compforge/harness-toolbox/kubernetes/client-node-pod-log";
import type { Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import { KubectlPodLogAccess } from "@compforge/harness-toolbox/kubernetes/pod-log";
import { mkdtempSync, writeFileSync } from "node:fs";
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
import { resolvePluginTraceIds, type ResolvedPluginTraceId } from "../../plugin/trace-id";
import {
  enforceKubernetesAccess,
} from "../../terminal/kubernetes-access";
import { runCollectBatch } from "../engine";
import { EvidenceBundle } from "../evidence";
import { collectCommandOutcome, evaluateCollectOutcome } from "../outcome";
import { recordFailureBundle } from "../output/failure-bundle";
import { ServiceDependencyRuntime } from "../shared/service-dependency";
import { buildIndexExpr } from "../trace/opensearch";
import {
  buildLogPattern,
  resolveLogServiceSelection,
  serviceLogErrorPatterns,
} from "./config";
import { detectLogEvidenceGaps, buildLogEvidence, logDetectors } from "./detector";
import { makeLogInspect, projectLogFacts } from "./fact/inspect";
import type {
  LogCollectOptions,
  LogCommandContext,
  LogDiagnosis,
  LogRenderStats,
  LogInspectionFacts,
} from "./model";
import type { LogOutputFormat } from "./output";
import { parseLogOutputFormat } from "./output";
import { makeLogProbe } from "./probe/service";
import { formatLogCaptureStats, renderLogResult, renderTimelineJsonl } from "./render";

import { logSummary } from "./summary";

export * from "./config";
export { resolveLogTimeWindow, validateLogTimeWindow } from "./window";
export * from "./detector";
export * from "./html";
export * from "./model";
export * from "./output";
export * from "./probe/service";
export * from "./render";
export interface CollectLogCliOpts {
  bizIds: readonly string[];
  itemConcurrency?: number;
  /** Complete trace evidence supplied by an earlier collect stage; never a new remote lookup. */
  traceWindows?: readonly TraceLogWindow[];
  dataWindows?: DataLogWindows;
  collectionStartedAt?: string;
  timePadding?: string;
  namespace?: string;
  pod?: string;
  container?: string;
  services?: readonly string[];
  since?: string;
  sinceTime?: string;
  untilTime?: string;
  errorsOnly?: boolean;
  pattern?: string;
  format?: string;
  kubeconfig?: string;
  context?: string;
  profile?: string;
  config?: string;
  output?: string;
}

export function defaultLogBundleName(traceId: string, now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `doctor-log-${traceId.slice(0, 12)}-${ts}`;
}

export function defaultLogBatchName(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `doctor-log-batch-${ts}`;
}

async function prepareLogBatch(
  opts: CollectLogCliOpts,
  plugin: PluginDefinition,
  commandContext: CommandContext,
) {
  let pattern: RegExp | undefined;
  let format: LogOutputFormat;
  try {
    validateLogTimeWindow(opts);
    pattern = buildLogPattern(!!opts.errorsOnly, opts.pattern);
    format = parseLogOutputFormat(opts.format);
  } catch (err) {
    useLogger().error(`${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  let collect: KubernetesCommandConfig | undefined;
  try {
    collect = await resolveKubernetesCommandConfig(opts, undefined, commandContext);
  } catch (err) {
    useLogger().error(`${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  if (!collect) {
    useLogger("collect").warn("已取消");
    return 130;
  }
  const resolved = {
    kubeconfig: collect.kubernetes.kubeconfig,
    source: collect.kubernetes.kubeconfigSource,
  };
  const resolvedNamespace = {
    namespace: collect.kubernetes.namespace,
    source: collect.kubernetes.namespaceSource,
  };
  if (resolved.source.startsWith("profile:")) {
    useLogger("collect").info(`kubeconfig 来自 ${resolved.source}（${resolved.kubeconfig}）`);
  }
  useLogger("collect").info(`namespace: ${resolvedNamespace.namespace}（${resolvedNamespace.source}）`);

  const executor = createKubernetesExecutor(collect);
  let services: string[] | undefined;
  try {
    services = await resolveLogServiceSelection({
      raw: opts.services,
      namespace: resolvedNamespace.namespace,
      catalog: plugin.services,
      executor,
      kubeconfig: resolved.kubeconfig,
      context: collect.kubernetes.context,
    });
  } catch (err) {
    useLogger().error(`${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  if (!services) {
    useLogger("collect").warn("已取消");
    return 130;
  }
  if (!services.length) {
    useLogger("collect").error("没有选中日志 Service；请从 Plugin Catalog 选择 --service");
    return 2;
  }
  useLogger("collect").info(`services: ${services.join(", ")}`);
  const selectionIds = opts.bizIds.length ? opts.bizIds : [undefined];
  const selections = await resolveLogWorkloads(services, selectionIds.map(bizId => ({
    bizId, ...resolveLogTimeWindow({ ...opts, id: bizId }), untilTime: opts.untilTime,
  })), plugin.services, commandContext, executor, {
    namespace: resolvedNamespace.namespace, kubeconfig: resolved.kubeconfig, context: collect.kubernetes.context,
  });
  const workloads = mergeLogWorkloads(selections.map(selection => selection.workloads));
  selections.forEach((selection, index) => {
    for (const [service, names] of Object.entries(selection.workloads)) {
      useLogger("collect:log").info(`${selectionIds[index] ?? "Service"} ${service}: Workload [${names.join(", ")}]${selection.summaries[service]?.text ? `；${selection.summaries[service]!.text}` : ""}`);
    }
    for (const gap of selection.gaps) useLogger("collect:log").warn(gap);
  });

  const selected = services.flatMap(name => plugin.services.find(name)!.workloads.filter(workload => workloads[name]?.includes(workload.name)))
    .filter(workload => !workload.namespace || workload.namespace === resolvedNamespace.namespace);
  if (selected.length) await enforceKubernetesAccess(resolveKubernetesCommandContext(executor, commandContext).access, {
    command: "doctor log",
    needs: [{
      requirement: "required", rule: { verb: "get", resource: "pods/log" },
      purpose: "读取 current/previous Container 日志",
    }, ...selected.flatMap(workload => {
      const location = workload.location;
      const needs: import("@compforge/doctor-plugin").KubernetesAccessNeed[] = [];
      if (location.kind !== "resource" || location.resource_kind !== "Pod") needs.push({
        requirement: "preferred", rule: { verb: "list", resource: "pods" },
        purpose: "定位 Workload 的 Pod", fallback: "记录对应 Workload 的证据缺口",
      });
      if (location.kind !== "labels") needs.push({
        requirement: "preferred",
        rule: {
          verb: "get", resourceName: location.name, resource: location.kind === "service" ? "services" : {
            Deployment: "deployments.apps", StatefulSet: "statefulsets.apps", DaemonSet: "daemonsets.apps", Pod: "pods",
          }[location.resource_kind]
        },
        purpose: `解析 Workload '${workload.name}' 的资源位置`, fallback: "其它 Workload 继续采集",
      });
      return needs;
    })],
  });

  const access = new ClientNodePodLogAccess(new KubectlPodLogAccess(executor, resolvedNamespace.namespace), {
    namespace: resolvedNamespace.namespace, kubeconfig: resolved.kubeconfig, context: collect.kubernetes.context, signal: commandContext.signal,
  });
  return { pattern, format, collect, resolved, resolvedNamespace, executor, services, access, selections };
}

/**
 * @spec IDs always select literal input keys plus trace or declared, evidenced object correlations; absent IDs select Service logs without business resolution.
 * @rule Unresolved identities never fall back to unfiltered Service collection.
 */
export async function runCollectLog(
  opts: CollectLogCliOpts,
  plugin: PluginDefinition,
  commandContext: CommandContext,
): Promise<CommandResult<LogOutput>> {
  const collectionStartedAt = opts.collectionStartedAt ?? new Date().toISOString();
  const profileTimePadding = commandContext.profile.value.log?.timePadding;
  timePaddingMs(opts.timePadding ?? profileTimePadding);
  const ids = [...new Set(opts.bizIds.map(item => item.trim()).filter(Boolean))];
  const requestIds: (string | undefined)[] = ids.length ? ids : [undefined];
  const untilTime = opts.untilTime ?? (!ids.length ? new Date().toISOString() : undefined);
  const prepared = await prepareLogBatch({ ...opts, bizIds: ids, untilTime }, plugin, commandContext);
  if (typeof prepared === "number") {
    const failure = commandOutcome(prepared);
    const output: LogOutput = {
      items: requestIds.map(bizId => ({
        bizId, status: failure.status, artifacts: [], reason: "日志采集准备未完成",
      })),
    };
    return { ...failure, output, summary: logSummary(output) };
  }
  const { collect, resolvedNamespace, resolved, executor, services, access } = prepared;
  const stagingRoot = mkdtempSync(join(tmpdir(), "doctor-log-"));
  const staging = join(stagingRoot, defaultLogBatchName(new Date()));
  const summary = commandContext.artifacts.add({ command: "log", path: staging });
  const bundle = new EvidenceBundle(staging);
  const associationServices = services.filter(name => prepared.selections.some(selection => selection.workloads[name]?.length));
  const associations = await collectLogAssociations({ ...opts, bizIds: ids, services: associationServices,
    namespace: resolvedNamespace.namespace }, plugin, commandContext, executor, join(staging, "associations"),
    line => useLogger("collect:log").info(line));
  writeFileSync(join(staging, "associations.json"), JSON.stringify(associations, null, 2));
  let trace: ResolvedPluginTraceId[] = [];
  let traceFailure: string | undefined;
  // No-ID collection must not resolve business IDs or prepare their database/store dependencies.
  if (ids.length && prepared.selections.some(selection => Object.values(selection.workloads).some(names => names.length)) && plugin.services.extensions("trace.resolve").length) {
    const dependencyRuntime = new ServiceDependencyRuntime({
      plugin,
      collect,
      executor,
      command: "doctor log",
      commandContext,
      index: buildIndexExpr(),
      endpoint: process.env.DOCTOR_OPENSEARCH_URL?.trim(),
      log: (line, tone) => {
        if (tone === "warning") useLogger().warn(`${line}`);
        else useLogger().info(`${line}`);
      },
    });
    try {
      trace = await resolvePluginTraceIds({
        bizIds: ids,
        namespace: resolvedNamespace.namespace,
        kubeconfig: resolved.kubeconfig,
        context: collect.kubernetes.context,
        profileName: collect.profileName,
        command: "doctor log",
        commandContext,
        resolveDependencies: (service) => dependencyRuntime.resolve(service),
      }, plugin, executor);
    } catch (err) {
      traceFailure = err instanceof Error ? err.message : String(err);
      useLogger("collect").warn(`trace 解析未完成，继续按输入 key 和对象关联采集：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      try {
        await dependencyRuntime.close();
      } catch (error) {
        useLogger("collect").warn(`Service capability 依赖清理失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const item of trace) {
      useLogger("collect").info(`biz-id: ${item.bizId} → trace-id: ${item.traceId}（${item.service} 按 ${item.resolvedAs} 解析）`);
    }
  }

  const localWindows = factsLogWindows(ids.map(bizId => ({ bizId, facts: associations.facts })));
  const dataWindows: DataLogWindows = {
    windows: [...(opts.dataWindows?.windows ?? []), ...localWindows.windows],
    rejected: [...(opts.dataWindows?.rejected ?? []), ...localWindows.rejected],
  };
  const requests: LogCollectOptions[] = requestIds.flatMap((bizId, index) => {
    const selection = prepared.selections[index]!;
    const selectedServices = services.filter(name => selection.workloads[name]?.length);
    if (!selectedServices.length) return [];
    const traces = trace.filter(trace => trace.bizId === bizId);
    const associationFacts = bizId === undefined ? undefined : projectDataFacts(associations.facts, bizId);
    const identities = associationFacts && bizId !== undefined
      ? logIdentities(associationFacts, bizId, plugin.services).filter(item => selectedServices.includes(item.service)) : [];
    const resolutionGaps = [...associations.gaps,
      ...(bizId !== undefined && plugin.services.extensions("trace.resolve").length && !traces.length
        ? [traceFailure ?? `${bizId} 未取得 trace 关联，保留输入 key 与已知对象关联`] : []), ...(associationFacts
      ? gapMessages(detectDataEvidenceGaps({ facts: associationFacts, observations: [] })) : [])];

    const timeWindow = selectLogTimeWindow({ id: bizId, traceIds: traces.map(trace => trace.traceId),
      traceWindows: opts.traceWindows, dataWindows, timePadding: opts.timePadding, profileTimePadding,
      now: new Date(collectionStartedAt), since: opts.since, sinceTime: opts.sinceTime, untilTime: opts.untilTime });
    for (const rejection of timeWindow.rejected) useLogger("collect").warn(
      `[collect:log] ${bizId} 忽略窗口 ${rejection.service}/${rejection.queryId}#${rejection.factIndex}：${rejection.reason}`);
    useLogger("collect").info(`[collect:log] ${bizId ?? "Service 日志"} window source=${timeWindow.source} from=${timeWindow.sinceTime ?? `since:${timeWindow.since}`} to=${timeWindow.untilTime ?? untilTime ?? "current"}`);
    for (const window of timeWindow.windows) useLogger("collect").info(
      `[collect:log] ${bizId ?? "Service 日志"} window source=${window.contribution ? `${window.contribution.service}/${window.contribution.queryId}#${window.contribution.factIndex}` : "trace"} from-source=${window.fromSource} to-source=${window.toSource} padding=${window.timePadding} padding-source=${window.paddingSource}`);
    if (timeWindow.fallbackReason) useLogger("collect").info(`[collect:log] ${bizId ?? "Service 日志"} ${timeWindow.fallbackReason}`);
    return [{
      bizId, keys: logKeys({ bizId, keys: traces.map(trace => ({ kind: "trace", identity: { kind: "trace_id", value: trace.traceId },
        resolution: { service: trace.service, resolvedAs: trace.resolvedAs, sourceId: trace.sourceId } })), identities }), associationFacts, resolutionGaps: [...resolutionGaps, ...selection.gaps], workloads: selection.workloads, namespace: resolvedNamespace.namespace,
      kubeconfig: resolved.kubeconfig, context: collect.kubernetes.context, services: selectedServices,
      since: timeWindow.since, sinceTime: timeWindow.sinceTime, untilTime: timeWindow.untilTime ?? untilTime, window: { ...timeWindow, untilTime: timeWindow.untilTime ?? untilTime },
      errorsOnly: !!opts.errorsOnly, pattern: opts.pattern, pod: opts.pod, container: opts.container,
      outputDir: join(stagingRoot, bizId === undefined ? "service-logs"
        : `biz-${index + 1}-${defaultLogBundleName(bizId, new Date())}`),
    }];
  });
  const artifacts = requests.map(request => commandContext.artifacts.add({ command: "log", path: request.outputDir }));
  const results = await collectLog(requests, commandContext, executor,
    line => useLogger().info(`${line}`), bundle, access, opts.itemConcurrency);
  const byId = new Map(requests.map((request, index) => [request.bizId, { request, result: results[index]!, artifact: artifacts[index]! }]));
  const items: LogOutput["items"][number][] = [];
  requestIds.forEach((bizId, index) => {
    const selection = prepared.selections[index]!;
    const empty = !Object.values(selection.workloads).some(names => names.length);
    if (empty && !commandContext.signal.aborted) {
      items.push({ bizId, status: selection.gaps.length ? CommandStatus.Failed : CommandStatus.Ok, artifacts: [],
        reason: selection.gaps.length ? selection.gaps.join("；") : "没有与本次输入相关的日志 Workload",
        ...(selection.gaps.length ? { missingEvidence: selection.gaps } : {}) });
      return;
    }
    const collected = byId.get(bizId);
    const status = collected?.result.status ?? (commandContext.signal.aborted ? CommandStatus.Cancelled : CommandStatus.Failed);
    const reason = collected?.result.reason ?? (!collected ? "日志请求未完成" : undefined);
    items.push({ bizId, status, artifacts: collected ? [collected.artifact] : [], ...(reason ? { reason } : {}),
      ...(collected ? { stats: collected.result.stats, missingEvidence: collected.result.missingEvidence, resolutionGaps: collected.result.resolutionGaps } : {}) });
  });
  writeFileSync(join(staging, "diagnosis.json"), JSON.stringify({
    workloadSelections: prepared.selections.map((selection, index) => ({ bizId: requestIds[index], ...selection })),
    items: items.map(({ artifacts, ...item }) => ({
      ...item, artifact_ids: artifacts.map(artifact => artifact.id),
    }))
  }, null, 2));
  const output: LogOutput = { namespace: resolvedNamespace.namespace, services, items };
  return { status: aggregateCommandStatus(items.map(item => item.status)), output,
    summary: logSummary(output), artifacts: [summary, ...artifacts] };
}

interface LogItemResult {
  status: CommandStatus;
  reason?: string;
  stats?: LogRenderStats;
  missingEvidence?: readonly string[];
  resolutionGaps?: readonly string[];
}

/** Acquires one Pod discovery snapshot; item probes share PodLogClient captures under the root Pod budget. */
export async function collectLog(
  requests: readonly LogCollectOptions[],
  commandContext: CommandContext,
  executor: Executor,
  log: (line: string) => void,
  bundle: EvidenceBundle,
  access?: KubernetesPodLogAccess,
  concurrency = 2,
): Promise<LogItemResult[]> {
  if (!requests.length) return [];
  const startedAt = new Date().toISOString();
  const first = requests[0]!;
  const services = [...new Set(requests.flatMap(request => request.services))];
  const workloads = mergeLogWorkloads(requests.map(request => request.workloads ?? Object.fromEntries(
    request.services.map(name => [name, commandContext.plugin.services.find(name)!.workloads.map(workload => workload.name)]))));
  const { environment } = await commandContext.environment(executor);
  const source = access ?? new ClientNodePodLogAccess(new KubectlPodLogAccess(executor, first.namespace), {
    namespace: first.namespace, signal: commandContext.signal, kubeconfig: first.kubeconfig, context: environment.context,
  });
  const contexts: LogCommandContext[] = requests.map(opts => {
    validateLogTimeWindow(opts);
    if (opts.bizId !== undefined && !logKeys(opts).length) throw new Error("按 ID 采集需要非空日志 key");
    return {
      command: commandContext, startedAtMs: Date.parse(startedAt),
      config: {
        ...opts, keys: logKeys(opts), context: environment.context,
        linePattern: buildLogPattern(opts.errorsOnly, opts.pattern,
          serviceLogErrorPatterns(commandContext.plugin.services, opts.services)),
      },
      access: source, bundle: new EvidenceBundle(opts.outputDir), log
    };
  });
  let executions: PromiseSettledResult<{ diagnosis: LogDiagnosis }>[];
  try {
    const execution = await runCollectBatch({
      ctx: { ...contexts[0]!, bundle, config: { ...contexts[0]!.config,
        pod: requests.every(request => request.pod === first.pod) ? first.pod : undefined,
        container: requests.every(request => request.container === first.container) ? first.container : undefined,
      } },
      inspects: [makeLogInspect(services, executor, workloads)],
      items: contexts.map(ctx => ({ ctx, config: ctx.config, projectFacts: (facts: Readonly<LogInspectionFacts>) => projectLogFacts(facts, ctx.config) })),
      concurrency, signal: commandContext.signal,
      planProbes: (_facts, config) => {
        useLogger().info(config.bizId === undefined
          ? "[collect:log] 采集阶段：按 Service / 时间范围采集（不按业务 ID 过滤）"
          : `[collect:log] 采集阶段 biz-id: ${config.bizId}`);
        return [makeLogProbe(config.services, executor)];
      }, log,
      buildEvidence: buildLogEvidence, detectors: [...logDetectors, detectLogEvidenceGaps],
      checkpointFacts: facts => bundle.writeCollection({
        doctorVersion: DOCTOR_CLI_VERSION, target: { namespace: first.namespace, input_ids: requests.flatMap(item => item.bizId === undefined ? [] : [item.bizId]), services },
        inspectionFacts: { ...facts }, params: {}, startedAt, finishedAt: new Date().toISOString(),
      }),
    });
    executions = execution.items;
  } catch (error) {
    executions = requests.map(() => ({ status: "rejected", reason: error }));
  }
  return contexts.map((ctx, index) => {
    const result = executions[index]!;
    try {
      if (result.status === "rejected") throw result.reason;
      return writeLogEvidence(ctx, result.value.diagnosis, startedAt);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      recordFailureBundle({ bundleDir: ctx.bundle.dir, collectCode: 1, reason });
      return { status: commandContext.signal.aborted ? CommandStatus.Cancelled : CommandStatus.Failed, reason };
    }
  });
}

function writeLogEvidence(ctx: LogCommandContext, diagnosis: LogDiagnosis, startedAt: string): LogItemResult {
  const { config, bundle, log } = ctx;
  const facts = diagnosis.evidence.facts;
  const rendered = renderLogResult(config, diagnosis);
  if (config.associationFacts) writeFileSync(join(bundle.dir, "associations.json"), JSON.stringify(config.associationFacts, null, 2));
  writeFileSync(join(bundle.dir, "timeline.jsonl"), renderTimelineJsonl(rendered.timeline), "utf-8");
  writeFileSync(join(bundle.dir, "service-logs.txt"), rendered.serviceLogs, "utf-8");
  writeFileSync(join(bundle.dir, "diagnosis.json"), `${JSON.stringify(diagnosis, null, 2)}\n`, "utf-8");
  bundle.writeSummary(rendered.summary);
  writeFileSync(join(bundle.dir, "log-stats.json"), `${JSON.stringify(rendered.stats, null, 2)}\n`, "utf-8");
  bundle.writeCollection({
    doctorVersion: DOCTOR_CLI_VERSION,
    kubectlVersion: facts.runtime.status === "collected" ? facts.runtime.kubectlVersion : undefined,
    target: { mode: config.bizId === undefined ? "service" : "correlated", keys: logKeys(config), resolution_gaps: config.resolutionGaps, workloads: config.workloads, namespace: config.namespace, pod: config.pod, container: config.container, biz_id: config.bizId, services: config.services },
    inspectionFacts: { ...facts },
    params: { window: config.window, since: config.since, since_time: config.sinceTime, until_time: config.untilTime, errors_only: config.errorsOnly, pattern: config.pattern },
    startedAt, finishedAt: new Date().toISOString(),
  });
  log(`[collect] ${config.bizId ?? "Service 日志"}: ${formatLogCaptureStats(rendered.stats, config.bizId === undefined)}`);
  const outcome = evaluateCollectOutcome([
    ...(diagnosis.evidence.facts.servicePods.status === "collected"
      ? Object.values(diagnosis.evidence.facts.servicePods.missing).flat().map(() => "unavailable" as const)
      : ["unavailable" as const]),
    ...diagnosis.evidence.observations.flatMap(item => item.pods.length
      ? item.pods.map(pod => pod.captureStatus === "complete" ? "ok" as const : pod.captureStatus === "partial" ? "partial" as const : "unavailable" as const)
      : ["unavailable" as const]),
  ]);
  return {
    status: config.resolutionGaps?.length && collectCommandOutcome(outcome).status === CommandStatus.Ok ? CommandStatus.Partial : collectCommandOutcome(outcome).status,
    // Project the already captured evidence; zero matches cannot stand in for a failed read.
    ...(facts.runtime.status === "collected" && facts.servicePods.status === "collected" ? { stats: rendered.stats } : {}),
    missingEvidence: [...new Set([...gapMessages(diagnosis.findings), ...(config.resolutionGaps ?? [])])],
    ...(config.resolutionGaps?.length ? { resolutionGaps: config.resolutionGaps } : {}),
    ...(outcome.evidence !== "complete" ? { reason: "日志证据不完整，详见采集结果与 Findings" } : {})
  };
}

export interface LogOutput {
  readonly namespace?: string;
  readonly services?: readonly string[];
  readonly items: readonly {
    bizId?: string; status: CommandStatus; reason?: string;
    stats?: LogRenderStats;
    missingEvidence?: readonly string[];
    /** Data acquisition gaps limit object correlation independently of Pod log capture. */
    resolutionGaps?: readonly string[];
    artifacts: readonly import("../../command").CommandArtifact[]
  }[];
}
