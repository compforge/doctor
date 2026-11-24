import { cpSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Operation, Service } from "@compforge/harness-common";
import { workloadResourceObservation, type MetricDBReader } from "@compforge/harness-toolbox/metricdb";
import { buildCallgraph, collectMetrics, loadRun, rangeObservation, serviceMetricProbes, operationMetricProbes, planMetrics, writeRunData, observesOnly, type Run, type PrometheusProbe } from "@compforge/perf-harness";
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

/**
 * @spec Observations read externally collected metrics through MetricDB for the realized run windows.
 * @why Missing metrics remain evidence gaps; diagnosis must not start a second scraper or query engine.
 * @link cli/docs/commands/perf.md
 */
export async function preparePerfMetrics(operations: readonly Operation[], context: CommandContext,
  source?: string | ReturnType<typeof openMetricDB>, services: readonly Pick<Service,"name"|"workloads"|"observes">[] = [], namespace?: string): Promise<PreparedPerfMetrics> {
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

function rangeIssues(run: Run): string[] {
  return run.executions.flatMap(arm => (arm.prometheus_observations ?? []).flatMap(query => {
    if (query.step_s === null) return [];
    const { status } = rangeObservation(arm, query);
    const reason = { query_error: "查询失败", not_collected: "尚未采集", empty_result: "窗口内无可用点", observed: undefined }[status];
    return reason ? [`${arm.id} / ${query.metric} 时间序列：${reason}`] : [];
  }));
}

/** Query evidence, not scrape assumptions: an empty result cannot identify why a source has no samples. */
export function perfMetricIssues(run: Run): string[] {
  const issues = new Set(rangeIssues(run));
  const graph = buildCallgraph(run);
  for (const arm of graph?.arms ?? []) for (const window of arm.windows) for (const node of window.nodes) {
    for (const [role, metric] of Object.entries(node.properties.perf.metrics)) {
      if (!metric.queries.length || metric.status === "observed") continue;
      const detail = metric.status === "error" ? "查询失败"
        : metric.reason === "not_collected" ? "尚未采集"
        : metric.reason === "empty_result" ? "查询成功，当前窗口无可计算值；若 hold 相对 scrape 间隔过短、窗口内只有 1 个采样点，无法计算增量属预期情况，建议延长 hold 至 4～5 个采样周期；空结果也可能没有匹配时序，不能仅凭此确认原因"
        : metric.reason === "no_observations" ? "查询成功，直方图在当前窗口没有可用于计算分位数的观测增量（不等同于未采集）"
        : "查询成功，当前窗口无可计算值（不等同于未采集或 scrape 故障）";
      issues.add(`${node.id} / ${arm.id}/${window.id} / ${role}：${detail}`);
    }
  }
  // Graph-less saved runs still retain query-level failures and unfinished reads.
  if (!graph) for (const arm of run.executions) for (const query of arm.prometheus_observations ?? []) {
    if (query.error || query.collected_at_s === null)
      issues.add(`${query.labels.operation ?? query.metric}：${query.error ? "查询失败" : "尚未采集"}`);
  }
  return [...issues];
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
      metricIssues.push(...gaps);
      if (gaps.length) useLogger("perf").warn(`指标覆盖存在 ${gaps.length} 项缺口；详见 Evidence Bundle 中 perf.json 的 metricIssues`);
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
