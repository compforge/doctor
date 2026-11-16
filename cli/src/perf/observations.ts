import { cpSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clientKey } from "@compforge/harness-common";
import { HttpClient } from "@compforge/harness-toolbox/http";
import { DirectTransport } from "@compforge/harness-toolbox/transport";
import { PrometheusClient, type PrometheusReader } from "@compforge/harness-toolbox/prometheus";
import { buildCallgraph, collectMetrics, loadRun, recollectMetrics, writeRunData, type Run } from "@compforge/perf-harness";
import { CommandStatus, type CommandContext, type CommandResult } from "../command";
import { writeOutput } from "../terminal/output";
import { createPerfArtifact } from "./output";
import { resolvePerfConfig } from "./config";
import type { PerfCliOpts, PerfResult } from "./model";

/** Borrow the command's bounded HTTP pool. Credentials never enter persisted query identity. */
export async function perfMetricSource(context: CommandContext, url?: string): Promise<PrometheusReader> {
  const profile = context.profile.value.prometheus;
  const endpoint = url?.trim() || profile?.url;
  if (!endpoint) throw new Error("Perf requires an external Prometheus/VM URL (--prometheus or profile.prometheus.url)");
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

/** Offline replay never resolves a Plugin or Case runner; recollection reuses frozen queries. */
export async function replayPerf(opts: PerfCliOpts, context: CommandContext): Promise<CommandResult<PerfResult>> {
  const config = resolvePerfConfig(opts);
  const original = loadRun(opts.from!);
  const artifact = createPerfArtifact(config);
  cpSync(opts.from!, artifact.path, { recursive: true });
  context.artifacts.add({ command: "perf", path: artifact.path });
  let run = original;
  if (opts.collectMetrics) {
    const source = await perfMetricSource(context, opts.prometheus);
    writeOutput("[perf] 使用保存的查询计划补采指标；原始目录保留。\n", process.stderr);
    try { run = await recollectMetrics(artifact.path, [source], { signal: context.signal }); }
    catch (error) { if (!context.signal.aborted) throw error; run = loadRun(artifact.path); }
  }
  const metadataPath = join(artifact.path, "perf.json");
  const metadata = existsSync(metadataPath) ? JSON.parse(readFileSync(metadataPath, "utf8")) : undefined;
  if (metadata && metadata.schema !== 1) throw new Error("Unsupported Doctor Perf metadata schema");
  const metricsComplete = perfMetricsComplete(run);
  return { status: context.signal.aborted ? CommandStatus.Cancelled
    : run.status !== "completed" || !metricsComplete ? CommandStatus.Partial : CommandStatus.Ok,
    output: { run, outputDir: artifact.path, metricsComplete, caseFacets: metadata?.caseFacets }, artifacts: context.artifacts.list() };
}
