import { cpSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Operation, Service } from "@compforge/harness-common";
import { workloadResourceObservation, type MetricDBReader } from "@compforge/harness-toolbox/metricdb";
import { buildCallgraph, collectMetrics, loadRun, rangeObservation, serviceMetricProbes, operationMetricProbes, planMetrics, writeRunData, observesOnly, type Run, type PrometheusProbe, type ServiceScrapeCoverage } from "@compforge/perf-harness";
import { CommandInputError, CommandStatus, type CommandContext, type CommandResult } from "../command";
import { useLogger } from "../terminal/log";
import { diagnosticMessage } from "../command/diagnostic";
import { openMetricDB } from "../datasource/metricdb";
import { createPerfArtifact } from "./output";
import { resolvePerfConfig } from "./config";
import type { PerfCliOpts, PerfResult } from "./model";

export function perfMetricsComplete(run: Run): boolean {
  const queries = run.executions.flatMap(arm => arm.prometheus_observations ?? []);
  if (!queries.length || queries.some(query => query.collected_at_s === null || query.error !== null)) return false;
  if (rangeIssues(run).length) return false;
  const graph = buildCallgraph(run);
  return !graph?.arms.some(arm => arm.windows.some(window => window.nodes.some(node =>
    Object.values(node.properties.perf.metrics).some(metric => metric.queries.length > 0 && metric.status !== "observed"))));
}

export async function collectPerfMetrics(run: Run, directory: string, source: MetricDBReader, signal: AbortSignal): Promise<void> {
  try { await collectMetrics(run, [source], { signal }); }
  catch (error) { if (!signal.aborted) throw error; }
  finally { writeRunData(run, directory); }
}

export interface PreparedPerfMetrics {
  declared: boolean;
  source?: MetricDBReader;
  probes: PrometheusProbe[];
  issues: string[];
}

/** @why A one-period lookback can contain just one scrape, leaving rate and histogram trends empty even when the target is up. */
function operationTrendWindows(probes: PrometheusProbe[], scrapes: readonly ServiceScrapeCoverage[]): PrometheusProbe[] {
  const intervals = new Map(scrapes.map(({service, groups}) => [
    service, Math.max(0, ...groups.filter(group => group.state === "active").map(group => group.intervalSeconds ?? 0)),
  ]));
  const adjusted = new Map<string, number>();
  const result = probes.map(probe => {
    const seconds = Math.ceil(4 * (intervals.get(probe.service) ?? 0));
    if (seconds <= 60) return probe;
    const summaries = probe.summaries.map(summary => {
      if (summary.trendWindowSeconds !== undefined || !summary.promql.includes("$window")) return summary;
      adjusted.set(probe.service, seconds);
      return {...summary, trendWindowSeconds:seconds};
    });
    return {...probe, summaries};
  });
  for (const [service, seconds] of adjusted) {
    useLogger("perf").info(`${service} 指标趋势：滚动窗口 ${seconds}s（4 个抓取周期）；窗口汇总按实际观测时间计算。`);
  }
  return result;
}

/**
 * @spec Observations read externally collected metrics through MetricDB for the realized run windows.
 * @why Missing metrics remain evidence gaps; diagnosis must not start a second scraper or query engine.
 * @link cli/docs/commands/perf.md
 */
export async function preparePerfMetrics(operations: readonly Operation[], context: CommandContext,
  source?: string | ReturnType<typeof openMetricDB>, services: readonly Pick<Service,"name"|"workloads"|"observes">[] = [],
  namespace?: string, scrapes: readonly ServiceScrapeCoverage[] = []): Promise<PreparedPerfMetrics> {
  const declared = operations.filter(operation => operation.observes?.some(item => item.type === "metricdb"));
  const targets = services.filter(service => service.workloads.length || service.observes?.some(item => item.type === "metricdb"));
  const prepared: PreparedPerfMetrics = { declared: declared.length + targets.length > 0, probes: [], issues: [] };
  const missing = (message: string) => { prepared.issues.push(message); useLogger("perf").warn(message); };
  if (!prepared.declared) {
    useLogger("perf").info("未声明观测指标或 Service workload；本轮只保留运行窗口与已有请求事实");
    return prepared;
  }
  try {
    const connection = await (typeof source === "string" || source === undefined ? openMetricDB(context, source) : source);
    prepared.source = await connection?.reader.connectQuery(context.signal);
    if (!prepared.source) {
      missing("已声明观测指标，但未配置 metricdb（Prometheus/VM）；本轮仅保留运行窗口与已有请求事实");
    } else {
      for (const operation of declared) {
        try {
          prepared.probes.push(...operationMetricProbes([operation], prepared.source.kind, op => ({service: op.serviceName, operation: op.name})));
        } catch (error) {
          missing(`${operation.id()} 指标未采集：${diagnosticMessage(error)}`);
        }
      }
      prepared.probes = operationTrendWindows(prepared.probes, scrapes);
      const backend = prepared.source.kind;
      for (const service of targets) {
        const declarations = [...(service.observes ?? [])];
        try {
          const resources = workloadResourceObservation(service.workloads, namespace);
          if (resources) declarations.push(resources);
        } catch (error) {
          missing(`${service.name} 资源指标未采集：${diagnosticMessage(error)}`);
        }
        try {
          prepared.probes.push(...serviceMetricProbes(service.name, declarations, backend, undefined, {service: service.name}));
        } catch (error) {
          missing(`${service.name} 指标未采集：${diagnosticMessage(error)}`);
        }
        for (const workload of service.workloads) {
          if (!workload.observes?.length) continue;
          try {
            prepared.probes.push(...serviceMetricProbes(service.name, workload.observes, backend, workload.name,
              {service: service.name, workload: workload.name}));
          } catch (error) {
            missing(`${service.name}/${workload.name} 指标未采集：${diagnosticMessage(error)}`);
          }
        }
      }
      useLogger("perf").info(`指标后端=${prepared.source.kind}；已准备 ${prepared.probes.length} 组指标查询（不代表已有样本），结束后按实际窗口读取`);
    }
  } catch (error) { missing(`指标源准备未完成：${diagnosticMessage(error)}`); }
  return prepared;
}

const issueLabels = {
  query_error: "查询失败",
  not_collected: "尚未采集",
  empty_trend: "趋势无可用点",
  empty_window: "窗口无可计算值",
  no_observations: "直方图无观测增量",
} as const;

const windowIssueDetails = {
  ...issueLabels,
  empty_window: "查询成功，当前窗口无可计算值。请结合「指标质量」的抓取周期、基线样本及实际 hold 核对。",
  no_observations: "查询成功，直方图在当前窗口没有可用于计算分位数的观测增量。",
};

interface MetricIssue {
  kind: keyof typeof issueLabels;
  entry: boolean;
  message: string;
}

function rangeIssues(run: Run): MetricIssue[] {
  const entries = new Set(run.entry_ids);
  const issues: MetricIssue[] = [];
  for (const arm of run.executions) for (const query of arm.prometheus_observations ?? []) {
    if (query.step_s === null) continue;
    const {status} = rangeObservation(arm, query);
    if (status === "observed") continue;
    const kind = status === "empty_result" ? "empty_trend" : status;
    issues.push({kind, entry:entries.has(query.labels.operation ?? ""),
      message:`${arm.id} / ${query.metric} 时间序列：${status === "empty_result" ? "窗口内无可用点" : issueLabels[kind]}`});
  }
  return issues;
}

/** Query evidence, not scrape assumptions: an empty result cannot identify why a source has no samples. */
export function perfMetricIssues(run: Run): MetricIssue[] {
  const issues = new Map(rangeIssues(run).map(issue => [issue.message, issue]));
  const graph = buildCallgraph(run);
  const entries = new Set(graph?.entry_ids ?? run.entry_ids);
  for (const arm of graph?.arms ?? []) for (const window of arm.windows) for (const node of window.nodes) {
    for (const [role, metric] of Object.entries(node.properties.perf.metrics)) {
      if (!metric.queries.length || metric.status === "observed") continue;
      const kind = metric.status === "error" ? "query_error"
        : metric.reason === "not_collected" || metric.reason === "no_observations" ? metric.reason : "empty_window";
      const message = `${node.id} / ${arm.id}/${window.id} / ${role}：${windowIssueDetails[kind]}`;
      issues.set(message, {kind, entry:entries.has(node.id), message});
    }
  }
  // Graph-less saved runs still retain query-level failures and unfinished reads.
  if (!graph) for (const arm of run.executions) for (const query of arm.prometheus_observations ?? []) {
    if (query.step_s !== null || (!query.error && query.collected_at_s !== null)) continue;
    const kind = query.error ? "query_error" : "not_collected";
    const message = `${arm.id}/${query.window_id} / ${query.metric}：${issueLabels[kind]}`;
    issues.set(message, {kind, entry:entries.has(query.labels.operation ?? ""), message});
  }
  return [...issues.values()];
}

export function formatMetricCoverageWarning(issues: readonly MetricIssue[]): string {
  const counts: Partial<Record<MetricIssue["kind"], number>> = {};
  let entryCount = 0;
  for (const {kind, entry} of issues) {
    counts[kind] = (counts[kind] ?? 0) + 1;
    if (entry) entryCount++;
  }
  const details = (Object.keys(issueLabels) as MetricIssue["kind"][]).flatMap(kind =>
    counts[kind] ? [`${issueLabels[kind]} ${counts[kind]}`] : []);
  return `指标覆盖不完整，共 ${issues.length} 项（入口 Operation ${entryCount} 项）。${details.join("，")}。详见「指标质量」及 perf.json 的 metricIssues。`;
}

/** @spec Declared observations are collected automatically; unavailable metrics cannot discard request facts or sibling observations. */
export async function observePerf(run: Run, directory: string, operations: readonly Operation[],
  context: CommandContext, url?: string, prepared?: PreparedPerfMetrics,
): Promise<Pick<PerfResult, "metricsComplete" | "metricIssues">> {
  const plan = prepared ?? await preparePerfMetrics(operations, context, url);
  if (!plan.declared) {
    const observationOnly = run.executions.every(arm => observesOnly(arm.arm.load));
    return { metricsComplete: !observationOnly, metricIssues: observationOnly ? ["本次仅记录观测窗口。要获取指标，请声明 observes 或 Service 的 Kubernetes Workload。"] : [] };
  }
  const metricIssues = [...plan.issues];
  const missing = (message: string) => { metricIssues.push(message); useLogger("perf").warn(message); };
  try {
    if (plan.source && plan.probes.length) {
      planMetrics(run, plan.probes, plan.source);
      writeRunData(run, directory);
      useLogger("perf").info(`请求与查询计划已保存；自动查询 ${plan.probes.length} 组指标`);
      await collectPerfMetrics(run, directory, plan.source, context.signal);
      const gaps = perfMetricIssues(run);
      metricIssues.push(...gaps.map(gap => gap.message));
      if (gaps.length) useLogger("perf").warn(formatMetricCoverageWarning(gaps));
    }
  } catch (error) { missing(`指标采集未完成：${diagnosticMessage(error)}`); }
  finally { writeRunData(run, directory); }
  return { metricsComplete: metricIssues.length === 0 && perfMetricsComplete(run), metricIssues };
}

/** Offline replay only reads saved facts; it never resolves a Plugin, runner or metric source. */
export async function replayPerf(opts: PerfCliOpts, context: CommandContext): Promise<CommandResult<PerfResult>> {
  const config = resolvePerfConfig(opts);
  const metadataPath = join(opts.from!, "perf.json");
  let metadata;
  if (existsSync(metadataPath)) {
    try { metadata = JSON.parse(readFileSync(metadataPath, "utf8")); }
    catch (error) { throw new CommandInputError(`无法读取 ${metadataPath}：${diagnosticMessage(error)}`); }
    if (!metadata || metadata.schema !== 1) throw new CommandInputError(`Unsupported Doctor Perf metadata schema: ${metadataPath}`);
  }
  const run = loadRun(opts.from!);
  run.case_entries ??= metadata?.caseEntries;
  const artifact = createPerfArtifact(config);
  cpSync(opts.from!, artifact.path, { recursive: true });
  context.artifacts.add({ command: "perf", path: artifact.path });
  const metricsComplete = metadata?.metricsComplete ?? perfMetricsComplete(run);
  return { status: context.signal.aborted ? CommandStatus.Cancelled
    : run.status !== "completed" || !metricsComplete ? CommandStatus.Partial : CommandStatus.Ok,
    output: { run, outputDir: artifact.path, metricsComplete, metricIssues: metadata?.metricIssues, scrape: metadata?.scrape, metricBaseline:metadata?.metricBaseline, caseFacets: metadata?.caseFacets }, artifacts: context.artifacts.list() };
}
