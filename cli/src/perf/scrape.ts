import type { ScrapeTarget, Service } from "@compforge/harness-common";
import type { ServiceScrapeCoverage } from "@compforge/perf-harness";
import { ToolboxError } from "@compforge/harness-toolbox/errors";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MetricDBError, matchServiceScrapeTargets, vmSelectTenant, listVMAgentInstances, findVMAgentCollectors,
  findPrometheusCollectors, summarizeScrapeTargets, type ScrapeGroup, type MetricCollector, type MetricDBClient } from "@compforge/harness-toolbox/metricdb";
import type { CommandContext } from "../command";
import type { openMetricDB } from "../datasource/metricdb";

import { kubernetesClientSource } from "../infra/k8s/resources";
import { resolveCollectKubeconfig } from "../infra/k8s/context";
import type { KubernetesCommandInput } from "../command/kubernetes-target";

type ScrapeService = Pick<Service, "name" | "workloads">;

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
  services?: ServiceScrapeCoverage[];
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
  namespace: string, targets: ScrapeTarget[], signal: AbortSignal, scrape: Pick<PerfScrape, "discoveryIssue">) {
  const {targets:matched, failures} = await matchServiceScrapeTargets(service, namespace, targets, async ref => {
    const access = await clusterResources(context, namespace, opts);
    return access.get({apiVersion:"v1", resource:"services", ...ref}, {signal});
  });
  context.signal.throwIfAborted();
  if (failures.length) scrape.discoveryIssue = failures.map(({namespace,name,error}) =>
    `读取 ${namespace}/${name} 的 Service selector 未完成（${scrapeFailure(error, signal)}）。`).join(" ");
  return matched;
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
  return {configs, active, matched};
}

/** @spec Only active targets matched to this Service contribute to its four-interval hold recommendation. */
export async function probePerfScrape(context: CommandContext, service: ScrapeService, namespace: string,
  client: ReturnType<typeof openMetricDB>, raw?: RawScrape, opts: KubernetesCommandInput = {}, services: readonly ScrapeService[] = []): Promise<PerfScrape> {
  const scrape: PerfScrape = {service: service.name, namespace, endpoint: "metricdb", groups: []};
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(5000)]);
  const { reader, configuredCollectorUrl } = client;
  scrape.endpoint = reader.scrapeEndpoint;
  scrape.metricdbUrl = reader.url;
  scrape.collectorUrl = evidenceEndpoint(configuredCollectorUrl ?? reader.url);
  let [configs, targets] = await Promise.allSettled([
    reader.getScrapeConfig(signal, raw && (yaml => { raw.configYaml = yaml; })),
    // @why state=any includes dropped targets and can return tens of MiB. Archive the active probe itself.
    reader.listScrapeTargets({state: "active"}, signal, raw && (body => { raw.targets = body; })),
  ]);
  let matched: ScrapeTarget[] | undefined;
  // A reachable targets API or an explicit collector already determines where discovery runs.
  if (reader.scrapeEndpoint === "metricdb" && targets.status === "rejected" && !signal.aborted
    && targets.reason instanceof MetricDBError && [400,404,405,501].includes(Number(targets.reason.code))
    && vmSelectTenant(reader.url) !== undefined) {
    try {
      const discovered = await probeDiscoveredCollector(reader, service, namespace, context, opts, signal, scrape, raw);
      if (discovered) {
        configs = discovered.configs;
        targets = {status:"fulfilled", value:discovered.active};
        matched = discovered.matched;
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
  const active = targets.value;
  const jobs = configs.status === "fulfilled" ? configs.value : [];
  matched ??= await matchTargets(context, opts, service, namespace, active, signal, scrape);
  scrape.groups = summarizeScrapeTargets(matched, jobs);
  for (const group of scrape.groups) {
    if (group.intervalSeconds) scrape.recommendedHoldSeconds = Math.max(scrape.recommendedHoldSeconds ?? 0, Math.ceil(4 * group.intervalSeconds));
  }
  const others = services.filter(other => other.name !== service.name);
  scrape.services = [{service:service.name, groups:scrape.groups, issue:scrape.discoveryIssue},
    ...await Promise.all(others.map(async other => {
      const diagnostic: Pick<PerfScrape,"discoveryIssue"> = {};
      const found = await matchTargets(context, opts, other, namespace, active, signal, diagnostic);
      return {service:other.name, groups:summarizeScrapeTargets(found, jobs), issue:diagnostic.discoveryIssue};
    }))];
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
