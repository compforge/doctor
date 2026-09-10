import type { KubernetesPodLogAccess } from "@compforge/doctor-toolkit/kubernetes/pod-log";
import { CommandStatus, aggregateCommandStatus, commandOutcome, type CommandResult } from "../../command";
import { terminalStdout, terminalStderr } from "../../terminal/output";
// log collect 编排：配置确认 → Inspect → 每 Service 一个 Probe → Render。
// Kubernetes 的 Pod 枚举和日志读取由 Toolkit 提供；本目录只保留业务选择和证据语义。
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOCTOR_CLI_VERSION } from "../../app/version";
import type { PluginDefinition } from "@compforge/doctor-plugin";
import type { Executor } from "@compforge/doctor-toolkit/kubernetes/executor";
import { KubectlPodLogAccess } from "@compforge/doctor-toolkit/kubernetes/pod-log";
import { ClientNodePodLogAccess } from "@compforge/doctor-toolkit/kubernetes/client-node-pod-log";
import { runCollectBatch } from "../engine";
import { resolveKubernetesCommandContext } from "../../command";
import type { CommandContext } from "../../command";
import {
  createKubernetesExecutor,
  resolveKubernetesCommandConfig,
  type KubernetesCommandConfig,
} from "../../command/kubernetes-target";
import { EvidenceBundle } from "../evidence";
import { recordFailureBundle } from "../output/failure-bundle";
import { collectCommandOutcome, evaluateCollectOutcome } from "../outcome";
import {
  enforceKubernetesAccess,
} from "../../terminal/kubernetes-access";
import {
  buildLogPattern,
  validateLogTimeWindow,
  resolveLogTimeWindow,
  resolveLogServiceSelection,
} from "./config";
import { buildLogCoverage, buildLogEvidence, logDetectors } from "./detector";
import { makeLogInspect } from "./fact/inspect";
import type {
  LogCollectOptions,
  LogCommandContext,
  LogDiagnosis,
} from "./model";
import { makeLogProbe } from "./probe/service";
import { formatLogCaptureStats, renderLogResult, renderTimelineJsonl } from "./render";
import { parseLogOutputFormat } from "./output";
import type { LogOutputFormat } from "./output";
import { writeLogHtmlReport } from "./html";
import { resolvePluginTraceIds } from "../../plugin/trace-id";
import { failedReportHtml, writeTabbedReport } from "../output/tabbed-report";
import { ServiceDependencyRuntime } from "../shared/service-dependency";
import { buildIndexExpr } from "../trace/opensearch";

export * from "./config";
export * from "./detector";
export * from "./html";
export * from "./model";
export * from "./output";
export * from "./probe/service";
export * from "./render";
export interface CollectLogCliOpts {
  bizIds: readonly string[];
  itemConcurrency?: number;
  namespace?: string;
  services?: string;
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
    terminalStderr.error(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  let collect: KubernetesCommandConfig | undefined;
  try {
    collect = await resolveKubernetesCommandConfig(opts, undefined, commandContext);
  } catch (err) {
    terminalStderr.error(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  if (!collect) {
    terminalStderr.warning("[collect] 已取消\n");
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
    terminalStdout.write(`[collect] kubeconfig 来自 ${resolved.source}（${resolved.kubeconfig}）\n`);
  }
  terminalStdout.write(`[collect] namespace: ${resolvedNamespace.namespace}（${resolvedNamespace.source}）\n`);

  const executor = createKubernetesExecutor(collect);
  await enforceKubernetesAccess(resolveKubernetesCommandContext(executor, commandContext).access, {
    command: "doctor log",
    needs: [{
      requirement: "required",
      rule: { verb: "list", resource: "services" },
      purpose: "解析待采集日志的 Service",
    }, {
      requirement: "required",
      rule: { verb: "list", resource: "pods" },
      purpose: "定位每个 Service 的 Running Pod",
    }, {
      requirement: "required",
      rule: { verb: "get", resource: "pods/log" },
      purpose: "读取 current/previous Container 日志",
    }],
  });
  const dependencyRuntime = new ServiceDependencyRuntime({
    plugin,
    collect,
    executor,
    command: "doctor log",
    commandContext,
    index: buildIndexExpr(),
    endpoint: process.env.DOCTOR_OPENSEARCH_URL?.trim(),
    log: (line, tone) => {
      if (tone === "warning") terminalStdout.warning(`${line}\n`);
      else terminalStdout.write(`${line}\n`);
    },
  });
  let trace;
  try {
    trace = await resolvePluginTraceIds({
      bizIds: opts.bizIds,
      namespace: resolvedNamespace.namespace,
      kubeconfig: resolved.kubeconfig,
      context: collect.kubernetes.context,
      profileName: collect.profileName,
      command: "doctor log",
      commandContext,
      resolveDependencies: (service) => dependencyRuntime.resolve(service),
    }, plugin, executor);
  } catch (err) {
    terminalStderr.error(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  } finally {
    try {
      await dependencyRuntime.close();
    } catch (error) {
      terminalStdout.warning(
        `[collect] Service capability 依赖清理失败：${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
  if (!trace) {
    terminalStderr.warning("[collect] 已取消\n");
    return 130;
  }
  for (const item of trace) {
    terminalStdout.write(`[collect] biz-id: ${item.bizId} → trace-id: ${item.traceId}（${item.service} 按 ${item.resolvedAs} 解析）\n`);
  }
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
    terminalStderr.error(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  if (!services) {
    terminalStderr.warning("[collect] 已取消\n");
    return 130;
  }
  terminalStdout.write(`[collect] services: ${services.join(", ")}\n`);

  const access = new ClientNodePodLogAccess(new KubectlPodLogAccess(executor, resolvedNamespace.namespace), {
    namespace: resolvedNamespace.namespace, kubeconfig: resolved.kubeconfig, context: collect.kubernetes.context, signal: commandContext.signal,
  });
  return { pattern, format, collect, resolved, resolvedNamespace, executor, trace, services, access };
}

/** @spec Log always resolves the complete input list before inspecting once and filtering per ID */
export async function runCollectLog(
  opts: CollectLogCliOpts,
  plugin: PluginDefinition,
  commandContext: CommandContext,
): Promise<CommandResult<LogOutput>> {
  const ids = [...new Set(opts.bizIds.map(item => item.trim()).filter(Boolean))];
  if (!ids.length) {
    return { status: CommandStatus.Failed, reason: "doctor log 需要至少一个 biz-id", artifacts: [] };
  }
  const prepared = await prepareLogBatch({ ...opts, bizIds: ids }, plugin, commandContext);
  if (typeof prepared === "number") {
    const failure = commandOutcome(prepared);
    return { ...failure, output: { items: ids.map(bizId => ({
      bizId, status: failure.status, artifacts: [], reason: "日志采集准备未完成",
    })) } };
  }
  const { collect, resolvedNamespace, resolved, executor, services, access } = prepared;
  const stagingRoot = mkdtempSync(join(tmpdir(), "doctor-log-"));
  const staging = join(stagingRoot, defaultLogBatchName(new Date()));
  const summary = commandContext.artifacts.add({ command: "log", path: staging });
  const bundle = new EvidenceBundle(staging);
  const requests = ids.flatMap((bizId, index) => {
    const traces = prepared.trace.filter(trace => trace.bizId === bizId);
    if (!traces.length) return [];
    const timeWindow = resolveLogTimeWindow({ id: bizId, since: opts.since, sinceTime: opts.sinceTime });
    if (!opts.since && !opts.sinceTime && timeWindow.sinceTime) {
      terminalStdout.write(`[collect] ${bizId} 从 UUIDv7 ID 推导日志起点: ${timeWindow.sinceTime}\n`);
    }
    return [{ bizId, traceIds: traces.map(trace => trace.traceId), namespace: resolvedNamespace.namespace,
      kubeconfig: resolved.kubeconfig, context: collect.kubernetes.context, services,
      since: timeWindow.since, sinceTime: timeWindow.sinceTime, untilTime: opts.untilTime,
      errorsOnly: !!opts.errorsOnly, pattern: opts.pattern,
      outputDir: join(stagingRoot, `biz-${index + 1}-${defaultLogBundleName(traces[0]!.traceId, new Date())}`),
    }];
  });
  const artifacts = requests.map(request => commandContext.artifacts.add({ command: "log", path: request.outputDir }));
  const results = await collectLog(requests, commandContext, executor,
    line => terminalStdout.write(`${line}\n`), bundle, access, opts.itemConcurrency);
  const byId = new Map(requests.map((request, index) => [request.bizId, { request, result: results[index]!, artifact: artifacts[index]! }]));
  const items: LogOutput["items"][number][] = [];
  const tabs = ids.map((bizId, index) => {
    const collected = byId.get(bizId);
    let status = collected?.result.status ?? (commandContext.signal.aborted ? CommandStatus.Cancelled : CommandStatus.Failed);
    let reason = collected?.result.reason ?? (!collected ? "无法解析 trace_id" : undefined);
    const reportPath = collected ? join(collected.request.outputDir, "report.html") : "";
    if (collected) {
      try { writeLogHtmlReport(collected.request.outputDir, reportPath, collect.profileName); }
      catch (error) {
        status = CommandStatus.Failed;
        reason = error instanceof Error ? error.message : String(error);
        recordFailureBundle({ bundleDir: collected.request.outputDir, collectCode: 1, reason });
      }
    }
    items.push({ bizId, status, artifacts: collected ? [collected.artifact] : [], ...(reason ? { reason } : {}) });
    return { key: `biz-${index + 1}`, label: bizId,
      status: existsSync(reportPath) ? "delivered" as const : "failed" as const,
      html: existsSync(reportPath) ? readFileSync(reportPath, "utf8") : failedReportHtml(`Log 诊断失败：${bizId}`, reason ?? "未形成诊断报告") };
  });
  writeTabbedReport(join(staging, "report.html"), {
    title: "doctor Log 日志报告", description: "按 Biz ID 独立筛选与诊断", ariaLabel: "Biz ID 日志诊断结果", tabs,
  });
  writeFileSync(join(staging, "diagnosis.json"), JSON.stringify({ items: items.map(({ artifacts, ...item }) => ({
    ...item, artifact_ids: artifacts.map(artifact => artifact.id),
  })) }, null, 2));
  return { status: aggregateCommandStatus(items.map(item => item.status)), output: { items }, artifacts: [summary, ...artifacts] };
}

interface LogItemResult { status: CommandStatus; reason?: string }

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
  const source = access ?? new ClientNodePodLogAccess(new KubectlPodLogAccess(executor, first.namespace), {
    namespace: first.namespace, signal: commandContext.signal, kubeconfig: first.kubeconfig, context: first.context,
  });
  const contexts: LogCommandContext[] = requests.map(opts => {
    validateLogTimeWindow(opts);
    if (!opts.traceIds.length) throw new Error("collectLog 需要至少一个 trace_id");
    return { command: commandContext, startedAtMs: Date.parse(startedAt),
      config: { ...opts, linePattern: buildLogPattern(opts.errorsOnly, opts.pattern) },
      access: source, bundle: new EvidenceBundle(opts.outputDir), log };
  });
  let executions: PromiseSettledResult<{ diagnosis: LogDiagnosis }>[];
  try {
    const execution = await runCollectBatch({
      ctx: { ...contexts[0]!, bundle },
      inspects: [makeLogInspect(first.services)],
      items: contexts.map(ctx => ({ ctx, config: ctx.config })),
      concurrency, signal: commandContext.signal,
      planProbes: (_facts, config) => {
        terminalStdout.warning(`\n[collect:log] biz-id: ${config.bizId}\n`);
        return [makeLogProbe(config.services)];
      }, log,
      buildEvidence: buildLogEvidence, detectors: logDetectors, buildCoverage: buildLogCoverage,
      checkpointFacts: facts => bundle.writeManifest({
        doctorVersion: DOCTOR_CLI_VERSION, target: { namespace: first.namespace, input_ids: requests.map(item => item.bizId), services: first.services },
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
  writeFileSync(join(bundle.dir, "timeline.jsonl"), renderTimelineJsonl(rendered.timeline), "utf-8");
  writeFileSync(join(bundle.dir, "service-logs.txt"), rendered.serviceLogs, "utf-8");
  writeFileSync(join(bundle.dir, "diagnosis.json"), `${JSON.stringify(diagnosis, null, 2)}\n`, "utf-8");
  bundle.writeSummary(rendered.summary);
  writeFileSync(join(bundle.dir, "log-stats.json"), `${JSON.stringify(rendered.stats, null, 2)}\n`, "utf-8");
  bundle.writeManifest({
    doctorVersion: DOCTOR_CLI_VERSION,
    kubectlVersion: facts.runtime.status === "collected" ? facts.runtime.kubectlVersion : undefined,
    target: { namespace: config.namespace, biz_id: config.bizId, trace_ids: config.traceIds, services: config.services },
    inspectionFacts: { ...facts },
    params: { since: config.since, since_time: config.sinceTime, until_time: config.untilTime, errors_only: config.errorsOnly, pattern: config.pattern },
    startedAt, finishedAt: new Date().toISOString(),
  });
  log(`[collect] ${config.bizId}: ${formatLogCaptureStats(rendered.stats)}`);
  const outcome = evaluateCollectOutcome(diagnosis.coverage.map(item => item.status === "sufficient"));
  return { status: collectCommandOutcome(outcome).status,
    ...(outcome.evidence !== "complete" ? { reason: "日志证据不完整，详见 Coverage" } : {}) };
}

export interface LogOutput {
  readonly items: readonly { bizId: string; status: CommandStatus; reason?: string;
    artifacts: readonly import("../../command").CommandArtifact[] }[];
}
