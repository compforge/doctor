import type { ScrapeTarget, Service } from "@compforge/harness-common";
import { parseDuration } from "@compforge/harness-toolbox/duration";
import { ToolboxError } from "@compforge/harness-toolbox/errors";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseServices } from "@compforge/harness-toolbox/kubernetes/service";
import { MetricDBError, matchesScrapeTarget, vmSelectTenant, listVMAgentInstances, findVMAgentCollectors,
  findPrometheusCollectors, type MetricCollector, type MetricDBClient } from "@compforge/harness-toolbox/metricdb";
import type { CommandContext } from "../command";
import type { openMetricDB } from "../datasource/metricdb";

import { kubernetesClientSource } from "../infra/k8s/resources";
import { resolveCollectKubeconfig } from "../infra/k8s/context";
import type { KubernetesCommandInput } from "../command/kubernetes-target";

type ScrapeService = Pick<Service, "name" | "workloads">;

interface ScrapeGroup {
  pool?: string;
  state: ScrapeTarget["state"];
  health?: string;
  intervalSeconds?: number;
  intervalSource?: "target" | "config";
  count: number;
}

/** Persist endpoint base URLs and matching job summaries. Raw evidence is archived separately. */
export interface PerfScrape {
  service: string;
  namespace: string;
  endpoint: "collector" | "metricdb";
  metricdbUrl?: string;
  collectorUrl?: string;
  configError?: string;
  targetsError?: string;
  discoveredCollector?: string;
  discoveryIssue?: string;
  vmagentInstances?: string[];
  groups: ScrapeGroup[];
  recommendedHoldSeconds?: number;
}

export interface RawScrape {
  configYaml?: string;
  targets?: Uint8Array;
}

/** Archive the collector's response, independent of Service matching and report rendering. */
export function writeScrapeFile(directory: string, name: "config.yaml" | "targets.json", data: string | Uint8Array): void {
  const raw = join(directory, "raw", "scrape");
  mkdirSync(raw, {recursive: true});
  writeFileSync(join(raw, name), data, {mode: 0o600});
}

function seconds(interval?: string): number | undefined {
  if (!interval) return;
  try { return parseDuration(interval) / 1000; } catch { return undefined; }
}

function scrapeFailure(error: unknown, signal: AbortSignal): string {
  if (error instanceof ToolboxError) return typeof error.code === "number" ? `HTTP ${error.code} (${error.kind})` : error.kind;
  return signal.aborted ? "timeout" : "unavailable";
}

/** @rule Evidence contains HTTP(S) base URLs only. Invalid endpoints can contain credential material. */
function evidenceEndpoint(value: string): string | undefined {
  if (!URL.canParse(value)) return;
  const url = new URL(value);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) return;
  return url.href.replace(/\/$/, "");
}

async function clusterResources(context: CommandContext, namespace: string, opts: KubernetesCommandInput) {
  const inspected = context.inspection.kubernetes;
  if (inspected && !inspected.channel.available) throw new Error("Kubernetes unavailable");
  const {kubeconfig} = inspected?.kubeconfig ?? resolveCollectKubeconfig(opts, context.profile);
  const client = await context.clients.get(kubernetesClientSource({namespace, kubeconfig, context:inspected?.context ?? opts.context}));
  return client.clusterResources();
}

async function matchTargets(context: CommandContext, opts: KubernetesCommandInput, service: ScrapeService,
  namespace: string, targets: ScrapeTarget[], signal: AbortSignal, scrape: PerfScrape) {
  const refs = service.workloads.length ? service.workloads.flatMap(workload => workload.location.kind === "service"
    ? [{name: workload.location.name, namespace: workload.namespace ?? namespace}] : []) : [{name:service.name, namespace}];
  const podNamespaces = new Set(targets.filter(target => target.discoveredLabels?.__meta_kubernetes_pod_name
    && !target.discoveredLabels.__meta_kubernetes_service_name && !target.labels?.service)
    .map(target => target.discoveredLabels?.__meta_kubernetes_namespace ?? target.labels?.namespace));
  const needed = new Map(refs.filter(ref => podNamespaces.has(ref.namespace)).map(ref => [ref.namespace + "/" + ref.name, ref]));
  const selectors = await Promise.allSettled([...needed.values()].map(async ref => {
    const access = await clusterResources(context, namespace, opts);
    const item = await access.get({apiVersion:"v1", resource:"services", ...ref}, {signal});
    return parseServices(JSON.stringify({items:[item]}), ref.namespace);
  }));
  context.signal.throwIfAborted();
  const failed = selectors.find(result => result.status === "rejected");
  if (failed) scrape.discoveryIssue = `读取 Kubernetes Service selector 未完成（${scrapeFailure(failed.reason, signal)}）。`;
  const services = selectors.flatMap(result => result.status === "fulfilled" ? result.value : []);
  return targets.filter(target => matchesScrapeTarget(service, namespace, target, services));
}

/** @rule Only a unique writer for this tenant with a matching active target supplies Perf evidence. */
async function probeDiscoveredCollector(reader: MetricDBClient, service: ScrapeService, namespace: string,
  context: CommandContext, opts: KubernetesCommandInput, signal: AbortSignal, scrape: PerfScrape, raw?: RawScrape) {
  const access = await clusterResources(context, namespace, opts);
  // @rule Preserve Operator discovery priority. An ambiguous set of VMAgents requires explicit selection.
  let candidates: MetricCollector[] = await findVMAgentCollectors(access, reader.url, namespace, signal);
  if (!candidates.length) {
    candidates = await findPrometheusCollectors(access, reader.url, namespace, url => reader.forCollector({url}), signal);
  }
  const names = candidates.map(candidate => candidate.namespace + "/" + candidate.service);
  if (candidates.length !== 1) {
    scrape.discoveryIssue = names.length ? `多个采集器写入当前租户：${names.join(", ")}。可显式配置 collector。`
      : "未找到可核对的当前 VM 租户采集器（VMAgent / Prometheus）。";
    return;
  }
  const {url} = candidates[0]!;
  const collector = reader.forCollector({url});
  let body: Uint8Array | undefined;
  const active = await collector.listScrapeTargets({state:"active"}, signal, bytes => { body = bytes; });
  const matched = await matchTargets(context, opts, service, namespace, active, signal, scrape);
  if (!matched.length) {
    scrape.discoveryIssue ??= `候选 ${names[0]} 未匹配到 ${namespace}/${service.name} 的 active target。`;
    return;
  }
  scrape.discoveredCollector = names[0];
  scrape.endpoint = "collector";
  scrape.collectorUrl = evidenceEndpoint(url);
  if (raw) { raw.targets = body; delete raw.configYaml; }
  const [configs] = await Promise.allSettled([collector.getScrapeConfig(signal, raw && (yaml => { raw.configYaml = yaml; }))]);
  return {configs, matched};
}

/** @spec Only active targets matched to this Service contribute to its four-interval hold recommendation. */
export async function probePerfScrape(context: CommandContext, service: ScrapeService, namespace: string,
  client: ReturnType<typeof openMetricDB>, raw?: RawScrape, opts: KubernetesCommandInput = {}): Promise<PerfScrape | undefined> {
  const scrape: PerfScrape = {service: service.name, namespace, endpoint: "metricdb", groups: []};
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(5000)]);
  let reader;
  try {
    const connection = await client;
    if (!connection) return;
    reader = connection.reader;
    scrape.endpoint = reader.scrapeEndpoint;
    scrape.metricdbUrl = reader.url;
    scrape.collectorUrl = evidenceEndpoint(connection.configuredCollectorUrl ?? reader.url);
  } catch (error) {
    context.signal.throwIfAborted();
    scrape.configError = scrape.targetsError = scrapeFailure(error, signal);
    return scrape;
  }
  let [configs, targets] = await Promise.allSettled([
    reader.getScrapeConfig(signal, raw && (yaml => { raw.configYaml = yaml; })),
    // @why state=any includes dropped targets and can return tens of MiB. Archive the active probe itself.
    reader.listScrapeTargets({state: "active"}, signal, raw && (body => { raw.targets = body; })),
  ]);
  if (targets.status === "fulfilled") {
    targets = {status:"fulfilled", value:await matchTargets(context, opts, service, namespace, targets.value, signal, scrape)};
  }
  // A reachable targets API or an explicit collector already determines where discovery runs.
  if (reader.scrapeEndpoint === "metricdb" && targets.status === "rejected" && !signal.aborted
    && targets.reason instanceof MetricDBError && [400,404,405,501].includes(Number(targets.reason.code))
    && vmSelectTenant(reader.url) !== undefined) {
    try {
      const discovered = await probeDiscoveredCollector(reader, service, namespace, context, opts, signal, scrape, raw);
      if (discovered) {
        configs = discovered.configs;
        targets = {status:"fulfilled", value:discovered.matched};
      }
    } catch (error) {
      context.signal.throwIfAborted();
      scrape.discoveryIssue = `VM 采集器发现未完成（${scrapeFailure(error, signal)}）。`;
    }
    if (!scrape.discoveredCollector && scrape.discoveryIssue && !signal.aborted) {
      try {
        const instances = await listVMAgentInstances(reader, Date.now() / 1000, signal);
        if (instances.length) scrape.vmagentInstances = instances;
      } catch { context.signal.throwIfAborted(); }
    }
  }
  context.signal.throwIfAborted();
  if (configs.status === "rejected") scrape.configError = scrapeFailure(configs.reason, signal);
  if (targets.status === "rejected") {
    scrape.targetsError = scrapeFailure(targets.reason, signal);
    return scrape;
  }
  const jobs = new Map((configs.status === "fulfilled" ? configs.value : []).map(job => [job.jobName, job]));
  const groups = new Map<string, ScrapeGroup>();
  for (const target of targets.value) {
    const pool = target.scrapePool;
    const targetInterval = seconds(target.scrapeInterval);
    const intervalSeconds = targetInterval ?? (pool ? seconds(jobs.get(pool)?.scrapeInterval) : undefined);
    const group: ScrapeGroup = { pool, state: target.state, health: target.health, intervalSeconds,
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
  if (scrape.discoveryIssue) lines.push(scrape.discoveryIssue);
  if (scrape.vmagentInstances?.length) lines.push(`vmagent 自监控指标中的 instance（仅供定位）：${scrape.vmagentInstances.join(", ")}。`);
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
