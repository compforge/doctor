import { cpSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clientKey, type Operation } from "@compforge/harness-common";
import { HttpClient } from "@compforge/harness-toolbox/http";
import { DirectTransport } from "@compforge/harness-toolbox/transport";
import { PrometheusClient, type PrometheusReader } from "@compforge/harness-toolbox/prometheus";
import { buildCallgraph, collectMetrics, loadRun, operationMetricProbes, planMetrics, writeRunData, type Run, type PrometheusProbe } from "@compforge/perf-harness";
import { CommandInputError, CommandStatus, type CommandContext, type CommandResult } from "../command";
import { useLogger } from "../terminal/log";
import { diagnosticMessage } from "../command/diagnostic";
import { createPerfArtifact } from "./output";
import { resolvePerfConfig } from "./config";
import type { PerfCliOpts, PerfResult } from "./model";

/** Borrow the command's bounded HTTP pool. Credentials never enter persisted query identity. */
export async function perfMetricSource(context: CommandContext, url?: string): Promise<PrometheusReader | undefined> {
  const profile = context.profile.value.prometheus;
  const endpoint = url?.trim() || profile?.url;
  if (!endpoint) return undefined;
  const limits = { concurrency: profile?.concurrency ?? 4, connectTimeoutMs: 10_000,
    requestTimeoutMs: profile?.timeout_ms ?? 30_000, maxResponseBytes: profile?.max_response_bytes ?? 4 * 1024 * 1024 };
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Prometheus access limits must be positive integers");
  const transport = await context.clients.get({ clientKey: clientKey("direct", {}), createClient: () => new DirectTransport() });
  const target = { endpoint };
  const http = await context.clients.get({ clientKey: clientKey("perf-prometheus-http", { target, limits }),
    createClient: (_clients, signal) => new HttpClient(target, transport, limits, { signal }) });
  const headers = profile?.username !== undefined || profile?.password !== undefined
    ? { Authorization: `Basic ${Buffer.from(`${profile?.username ?? ""}:${profile?.password ?? ""}`).toString("base64")}` } : undefined;
  return new PrometheusClient(http, { url: endpoint, kind: profile?.kind, headers });
}

export function perfMetricsComplete(run: Run): boolean {
  const queries = run.executions.flatMap(arm => arm.prometheus_observations ?? []);
  if (!queries.length || queries.some(query => query.collected_at_s === null || query.error !== null)) return false;
  const graph = buildCallgraph(run);
  return !graph?.arms.some(arm => arm.windows.some(window => window.nodes.some(node =>
    Object.values(node.properties.perf.metrics).some(metric => metric.queries.length > 0 && metric.status !== "observed"))));
}

export async function collectPerfMetrics(run: Run, directory: string, source: PrometheusReader, signal: AbortSignal): Promise<void> {
  try { await collectMetrics(run, [source], { signal }); }
  catch (error) { if (!signal.aborted) throw error; }
  finally { writeRunData(run, directory); }
}

/** @spec Operation probes are collected automatically; unavailable metrics cannot discard request facts or sibling observations. */
export async function observePerf(run: Run, directory: string, operations: readonly Operation[],
  context: CommandContext, namespace: string, url?: string,
): Promise<Pick<PerfResult, "metricsComplete" | "metricIssues">> {
  const declared = operations.filter(operation => operation.probes?.length);
  if (!declared.length) return { metricsComplete: true, metricIssues: [] };
  const metricIssues: string[] = [];
  const missing = (message: string) => { metricIssues.push(message); useLogger("perf").warn(message); };
  try {
    const source = await perfMetricSource(context, url);
    if (!source) {
      missing("Operation 已声明 probe，但未配置 Prometheus/VM；仅保留请求事实");
    } else {
      const probes: PrometheusProbe[] = [];
      for (const operation of declared) {
        try {
          probes.push(...operationMetricProbes([operation], source.kind, item => ({ namespace,
            ...context.profile.value.prometheus?.parameters?.[item.serviceName],
          })));
        } catch (error) {
          missing(`${operation.id()} 指标未采集：${diagnosticMessage(error)}`);
        }
      }
      if (probes.length) {
        planMetrics(run, probes, source);
        writeRunData(run, directory);
        useLogger("perf").info(`请求与查询计划已保存；自动查询 ${probes.length} 组 Operation 指标`);
        await collectPerfMetrics(run, directory, source, context.signal);
        if (!perfMetricsComplete(run)) missing("部分指标查询失败或缺少样本；已取得的指标与请求事实均已保留");
      }
    }
  } catch (error) {
    missing(`指标采集未完成：${diagnosticMessage(error)}`);
  } finally {
    writeRunData(run, directory);
  }
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
  const artifact = createPerfArtifact(config);
  cpSync(opts.from!, artifact.path, { recursive: true });
  context.artifacts.add({ command: "perf", path: artifact.path });
  const metricsComplete = metadata?.metricsComplete ?? perfMetricsComplete(run);
  return { status: context.signal.aborted ? CommandStatus.Cancelled
    : run.status !== "completed" || !metricsComplete ? CommandStatus.Partial : CommandStatus.Ok,
    output: { run, outputDir: artifact.path, metricsComplete, metricIssues: metadata?.metricIssues, caseFacets: metadata?.caseFacets }, artifacts: context.artifacts.list() };
}
