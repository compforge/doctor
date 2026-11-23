import type { ScrapeTarget, Service } from "@compforge/harness-common";
import { parseDuration } from "@compforge/harness-toolbox/duration";
import { ToolboxError } from "@compforge/harness-toolbox/errors";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HttpResponse } from "@compforge/harness-toolbox/http";
import type { CommandContext } from "../command";
import { openScrapeReader } from "../datasource/metricdb";

type ScrapeService = Pick<Service, "name" | "workloads">;

interface ScrapeGroup {
  pool?: string;
  state: ScrapeTarget["state"];
  health?: string;
  intervalSeconds?: number;
  intervalSource?: "target" | "config";
  count: number;
}

/** Persist only matching job names, timing and health counts. Discovery labels and URLs may contain secrets. */
export interface PerfScrape {
  service: string;
  namespace: string;
  endpoint: "collector" | "metricdb";
  configError?: string;
  targetsError?: string;
  groups: ScrapeGroup[];
  recommendedHoldSeconds?: number;
}

/** Archive the collector's response, independent of Service matching and report rendering. */
export class ScrapeFiles {
  private config?: string;
  private targets?: Uint8Array;

  capture(url: string, response: HttpResponse): void {
    if (response.status !== 200) return;
    const path = new URL(url).pathname;
    if (path.endsWith("/targets")) {
      this.targets = response.body;
    } else if (path.endsWith("/status/config")) {
      // The API encloses the original YAML string in JSON. Preserve comments and formatting.
      try {
        const envelope = JSON.parse(new TextDecoder().decode(response.body));
        if (envelope?.status === "success" && typeof envelope.data?.yaml === "string") this.config = envelope.data.yaml;
      } catch { /* The reader records invalid_response in the scrape summary. */ }
    }
  }

  write(directory: string): void {
    if (this.config === undefined && this.targets === undefined) return;
    const raw = join(directory, "raw", "scrape");
    mkdirSync(raw, {recursive: true});
    if (this.config !== undefined) writeFileSync(join(raw, "config.yaml"), this.config, {mode: 0o600});
    if (this.targets !== undefined) writeFileSync(join(raw, "targets.json"), this.targets, {mode: 0o600});
  }
}

function matchesTarget(service: ScrapeService, namespace: string, target: ScrapeTarget): boolean {
  const meta = target.discoveredLabels ?? {};
  const labels = target.labels ?? {};
  const ns = meta.__meta_kubernetes_namespace ?? labels.namespace;
  const serviceName = meta.__meta_kubernetes_service_name ?? labels.service;
  if (!service.workloads.length) return ns === namespace && serviceName === service.name;
  return service.workloads.some(workload => {
    if (ns !== (workload.namespace ?? namespace)) return false;
    const location = workload.location;
    if (location.kind === "service") return serviceName === location.name;
    if (location.kind === "labels") {
      const entries = Object.entries(location.labels);
      return entries.length > 0 && entries.every(([key, value]) =>
        meta["__meta_kubernetes_pod_label_" + key.replace(/[^a-zA-Z0-9_]/g, "_")] === value);
    }
    if (location.resource_kind === "Pod") return (meta.__meta_kubernetes_pod_name ?? labels.pod) === location.name;
    return meta.__meta_kubernetes_pod_controller_kind === location.resource_kind
      && meta.__meta_kubernetes_pod_controller_name === location.name;
  });
}

function seconds(interval?: string): number | undefined {
  if (!interval) return;
  try { return parseDuration(interval) / 1000; } catch { return undefined; }
}

function failure(error: unknown, signal: AbortSignal): string {
  if (error instanceof ToolboxError) return typeof error.code === "number" ? `HTTP ${error.code} (${error.kind})` : error.kind;
  return signal.aborted ? "timeout" : "unavailable";
}

/** @spec Only active targets matched to this Service contribute to its four-interval hold recommendation. */
export async function probePerfScrape(context: CommandContext, service: ScrapeService, namespace: string, url?: string, files?: ScrapeFiles): Promise<PerfScrape | undefined> {
  const profile = context.profile.value.metricdb;
  const override = url?.trim();
  const access = override && override !== profile?.url ? {url: override} : profile?.collector ?? profile;
  if (!access) return;
  const scrape: PerfScrape = { service: service.name, namespace, endpoint: access === profile?.collector ? "collector" : "metricdb", groups: [] };
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(5000)]);
  let reader;
  try { reader = await openScrapeReader(context, access, files?.capture.bind(files)); }
  catch (error) {
    context.signal.throwIfAborted();
    scrape.configError = scrape.targetsError = failure(error, signal);
    return scrape;
  }
  const [configs, targets] = await Promise.allSettled([reader.getScrapeConfig(signal), reader.listScrapeTargets({state: "any"}, signal)]);
  context.signal.throwIfAborted();
  if (configs.status === "rejected") scrape.configError = failure(configs.reason, signal);
  if (targets.status === "rejected") {
    scrape.targetsError = failure(targets.reason, signal);
    return scrape;
  }
  const jobs = new Map((configs.status === "fulfilled" ? configs.value : []).map(job => [job.jobName, job]));
  const groups = new Map<string, ScrapeGroup>();
  for (const target of targets.value) {
    if (!matchesTarget(service, namespace, target)) continue;
    const pool = target.scrapePool;
    const active = target.state === "active";
    const targetInterval = active ? seconds(target.scrapeInterval) : undefined;
    const intervalSeconds = targetInterval ?? (active && pool ? seconds(jobs.get(pool)?.scrapeInterval) : undefined);
    const group: ScrapeGroup = { pool, state: target.state, health: active ? target.health : undefined, intervalSeconds,
      intervalSource: targetInterval ? "target" : intervalSeconds ? "config" : undefined, count: 1 };
    const key = JSON.stringify(group);
    const existing = groups.get(key);
    if (existing) existing.count++;
    else groups.set(key, group);
    if (intervalSeconds) scrape.recommendedHoldSeconds = Math.max(scrape.recommendedHoldSeconds ?? 0, Math.ceil(4 * intervalSeconds));
  }
  scrape.groups = [...groups.values()];
  return scrape;
}

export function scrapeGroupSummary(group: ScrapeGroup): string {
  const interval = group.intervalSeconds === undefined ? "未知" : `${group.intervalSeconds}s (${group.intervalSource})`;
  return `抓取任务 ${group.pool ?? "(未知)"}：${group.count} 个 ${group.state} target，健康状态 ${group.health ?? "未知"}，间隔 ${interval}`;
}

export function scrapeAdvice(scrape: PerfScrape, hold?: number): string[] {
  const lines: string[] = [];
  if (scrape.configError) lines.push(`config API：${scrape.configError}。`);
  if (scrape.targetsError) lines.push(`targets API：${scrape.targetsError}。`);
  if (scrape.configError || scrape.targetsError) lines.push("核对采集器 API 地址和读取权限；采集与存储分离时可配置 metricdb.collector.url。");
  if (!scrape.targetsError && !scrape.groups.length) lines.push(`未匹配到 ${scrape.namespace}/${scrape.service} 的 target；请核对采集器、namespace、服务发现及 relabel 标签。`);
  if (scrape.groups.some(g => g.state === "dropped")) lines.push("有匹配的 dropped target，请核对服务发现与 relabel 规则。");
  if (scrape.groups.some(g => g.health === "down")) lines.push("有匹配的 target 处于 down，请在采集器 Targets 页面查看 last error。");
  if (scrape.groups.some(g => g.state === "active" && !g.intervalSeconds)) lines.push("部分 active target 的抓取间隔未知，请核对对应 job 的 scrape_interval。");
  if (hold !== undefined && scrape.recommendedHoldSeconds && hold < scrape.recommendedHoldSeconds) {
    lines.push(`hold ${hold}s 短于 4 个抓取周期，建议至少 ${scrape.recommendedHoldSeconds}s，以便计算窗口增量。`);
  }
  return lines;
}
