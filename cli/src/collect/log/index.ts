import { terminalStdout, terminalStderr } from "../../terminal/output";
// log collect 编排：配置确认 → Inspect → 每 Service 一个 Probe → Render。
// Kubernetes 的 Pod 枚举和日志读取由 infra/k8s 提供；本目录只保留业务选择和证据语义。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOCTOR_CLI_VERSION } from "../../app/version";
import type { PluginDefinition } from "@compforge/doctor-plugin";
import type { Executor } from "../../infra/k8s/executor";
import { KubectlPodLogAccess } from "../../infra/k8s/pod-log";
import { ClientNodePodLogAccess } from "../../infra/k8s/client-node-pod-log";
import { runCollect } from "../engine";
import { resolveKubernetesCommandContext } from "../../command";
import type { CommandContext } from "../../command";
import {
  createKubernetesExecutor,
  resolveKubernetesCommandConfig,
  type KubernetesCommandConfig,
} from "../../command/kubernetes-target";
import { EvidenceBundle } from "../evidence";
import { recordFailureBundle } from "../output/failure-bundle";
import { evaluateCollectOutcome } from "../outcome";
import {
  enforceKubernetesAccess,
} from "../../terminal/kubernetes-access";
import {
  buildLogPattern,
  resolveLogTimeWindow,
  resolveLogServiceSelection,
} from "./config";
import { buildLogCoverage, buildLogEvidence, logDetectors } from "./detector";
import { makeLogInspect } from "./fact/inspect";
import type {
  LogCollectOptions,
  LogCommandContext,
  LogProbeConfig,
} from "./model";
import { makeLogProbe } from "./probe/service";
import { renderLogResult, renderTimelineJsonl } from "./render";
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
  bizIds?: string[];
  /** @deprecated Use bizIds. */
  bizId?: string;
  namespace?: string;
  services?: string;
  since?: string;
  sinceTime?: string;
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

async function runCollectLogSingle(
  opts: CollectLogCliOpts,
  plugin: PluginDefinition,
  commandContext: CommandContext,
): Promise<number> {
  let pattern: RegExp | undefined;
  let format: LogOutputFormat;
  try {
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
  const selected = trace[0];
  if (!selected) {
    terminalStderr.error("doctor log 需要至少一个 biz-id\n");
    return 2;
  }
  terminalStdout.write(
    `[collect] biz-id: ${selected.bizId} → trace-id: ${trace.map((item) => item.traceId).join(", ")}`
    + `（${selected.service} 按 ${selected.resolvedAs} 解析）\n`,
  );
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

  const timeWindow = resolveLogTimeWindow({
    id: selected.bizId,
    since: opts.since,
    sinceTime: opts.sinceTime,
  });
  if (!opts.since && !opts.sinceTime && timeWindow.sinceTime) {
    terminalStdout.write(`[collect] 从 UUIDv7 ID 推导日志起点: ${timeWindow.sinceTime}\n`);
  }

  const bundleName = defaultLogBundleName(selected.traceId, new Date());
  const staging = join(mkdtempSync(join(tmpdir(), "doctor-collect-")), bundleName);
  commandContext.artifacts.add("log", staging);
  const code = await collectLog(
    {
      bizId: selected.bizId,
      traceIds: trace.map((item) => item.traceId),
      namespace: resolvedNamespace.namespace,
      kubeconfig: resolved.kubeconfig,
      context: collect.kubernetes.context,
      services,
      since: timeWindow.since,
      sinceTime: timeWindow.sinceTime,
      errorsOnly: !!opts.errorsOnly,
      pattern: opts.pattern,
      outputDir: staging,
    },
    commandContext,
    executor,
    (line) => terminalStdout.write(`${line}\n`),
    pattern,
  );
  let reportError: string | undefined;
  const reportPath = join(staging, "report.html");
  try {
    writeLogHtmlReport(
      staging,
      reportPath,
      collect.profileName,
    );
  } catch (error) {
    reportError = error instanceof Error ? error.message : String(error);
    terminalStderr.error(`[collect] Log HTML 生成失败：${reportError}\n`);
  }
  if (code === 0 && !reportError && format === "html") {
    return 0;
  }
  if (reportError || code !== 0) {
    recordFailureBundle({ bundleDir: staging, collectCode: code || 1, reason: reportError });
  }
  return reportError ? 1 : code;
}

/** Batch wrapper: each biz-id keeps its own log evidence and only the delivery shell is shared. */
export async function runCollectLog(
  opts: CollectLogCliOpts,
  plugin: PluginDefinition,
  commandContext: CommandContext,
): Promise<number> {
  const ids = [...new Set([
    ...(opts.bizIds ?? []),
    ...(opts.bizId ? [opts.bizId] : []),
  ].map((item) => item.trim()).filter(Boolean))];
  if (!ids.length) {
    terminalStderr.error("doctor log 需要至少一个 biz-id\n");
    return 2;
  }
  if (ids.length === 1) {
    return runCollectLogSingle({ ...opts, bizIds: ids }, plugin, commandContext);
  }

  let format;
  try {
    format = parseLogOutputFormat(opts.format);
  } catch (error) {
    terminalStderr.error(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const batchName = defaultLogBatchName(new Date());
  const stagingRoot = mkdtempSync(join(tmpdir(), "doctor-log-tabs-"));
  const staging = join(stagingRoot, batchName);
  mkdirSync(staging, { recursive: true });
  commandContext.artifacts.add("log", staging);
  const tabs = [];
  let exitCode = 0;
  for (const [index, bizId] of ids.entries()) {
    const artifactOffset = commandContext.artifacts.list().length;
    const code = await runCollectLogSingle(
      { ...opts, bizIds: [bizId], format: "html", output: undefined },
      plugin,
      commandContext,
    );
    if (code === 130) {
      return code;
    }
    const childArtifact = commandContext.artifacts.list()[artifactOffset];
    const htmlPath = childArtifact ? join(childArtifact.path, "report.html") : "";
    tabs.push({
      key: `biz-${index + 1}`,
      label: bizId,
      status: code === 0 && existsSync(htmlPath) ? "delivered" as const : "failed" as const,
      html: code === 0 && existsSync(htmlPath)
        ? readFileSync(htmlPath, "utf8")
        : failedReportHtml(`Log 诊断失败：${bizId}`, `采集退出码 ${code}`),
    });
    exitCode = Math.max(exitCode, code);
  }

  writeTabbedReport(join(staging, "report.html"), {
    title: "doctor Log 日志报告",
    description: "同一批次采集，每个 Biz ID 独立筛选与诊断",
    ariaLabel: "Biz ID 日志诊断结果",
    tabs,
  });
  return exitCode;
}

export async function collectLog(
  opts: LogCollectOptions,
  commandContext: CommandContext,
  executor: Executor,
  log: (line: string) => void,
  linePattern: RegExp | undefined = buildLogPattern(opts.errorsOnly, opts.pattern),
): Promise<number> {
  const startedAt = new Date().toISOString();
  const bundle = new EvidenceBundle(opts.outputDir);
  const traceIds = [...new Set([
    ...(opts.traceIds ?? []),
    ...(opts.traceId ? [opts.traceId] : []),
  ].map((item) => item.trim()).filter(Boolean))];
  if (!traceIds.length) throw new Error("collectLog 需要至少一个 trace_id");
  const config: LogProbeConfig = { ...opts, traceIds, linePattern };
  const ctx: LogCommandContext = {
    command: commandContext,
    config,
    access: new ClientNodePodLogAccess(
      new KubectlPodLogAccess(executor, opts.namespace),
      {
        namespace: opts.namespace,
        kubeconfig: opts.kubeconfig,
        context: opts.context,
      },
    ),
    bundle,
    log,
  };

  const execution = await runCollect({
    ctx,
    config,
    inspects: [makeLogInspect(opts.services)],
    planProbes: () => [makeLogProbe(opts.services)],
    log,
    buildEvidence: buildLogEvidence,
    detectors: logDetectors,
    buildCoverage: buildLogCoverage,
  });
  const { facts, diagnosis } = execution;
  const rendered = renderLogResult(config, diagnosis);
  writeFileSync(join(opts.outputDir, "timeline.jsonl"), renderTimelineJsonl(rendered.timeline), "utf-8");
  writeFileSync(join(opts.outputDir, "service-logs.txt"), rendered.serviceLogs, "utf-8");
  writeFileSync(join(opts.outputDir, "diagnosis.json"), `${JSON.stringify(diagnosis, null, 2)}\n`, "utf-8");
  bundle.writeSummary(rendered.summary);

  const kubectlVersion = facts.runtime.status === "collected"
    ? facts.runtime.kubectlVersion
    : undefined;
  bundle.writeManifest({
    doctorVersion: DOCTOR_CLI_VERSION,
    kubectlVersion,
    target: {
      namespace: opts.namespace,
      biz_id: opts.bizId ?? traceIds[0],
      trace_id: traceIds.length === 1 ? traceIds[0] : undefined,
      trace_ids: traceIds,
      services: opts.services,
    },
    inspectionFacts: facts,
    params: {
      since: opts.since,
      since_time: opts.sinceTime,
      errors_only: opts.errorsOnly,
      pattern: opts.pattern,
    },
    startedAt,
    finishedAt: new Date().toISOString(),
  });

  if (facts.runtime.status !== "collected") return 1;
  if (facts.servicePods.status !== "collected") return 1;
  log(
    `[collect] 完成（扫描 ${rendered.stats.podCount} pod，命中 ${rendered.stats.matchedEventCount} 个日志事件，`
    + `部分采集 ${rendered.stats.partialCount} pod，不可用 ${rendered.stats.unavailableCount} pod）。`,
  );
  return evaluateCollectOutcome(
    diagnosis.coverage.map((item) => item.status === "sufficient"),
  ).exitCode;
}
