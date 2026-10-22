import { connectionDataSources } from "@compforge/doctor-plugin";
import { parseExposition } from "@compforge/prombed";
import type {
  Database,
  PluginDefinition,
  ServiceCatalog,
  ServiceRedisDataSource,
  ServiceRedisClient,
} from "@compforge/doctor-plugin";
import type { CommandContext } from "../../../command";
import type { KubernetesCommandConfig } from "../../../command/kubernetes-target";
import { borrowDatabase } from "../../../datasource/database";
import type { DatabaseTarget } from "../../../infra/database";
import type { Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import type { ServicePortForwarder } from "@compforge/harness-toolbox/kubernetes/service-port-forward";
import {
  listServiceNetwork,
  type KubernetesService,
} from "@compforge/harness-toolbox/kubernetes/service";
import type { EmbeddedMetricSource, MetricFetch } from "../../../infra/metric";
import type { RedisEndpoint } from "@compforge/harness-toolbox/redis/index";
import { borrowServiceClient } from "../../../datasource/client";
import { STORE_METRIC_NAMES, type MetricStoreKind } from "./contract";

const EXPORTER_MAX_BODY_BYTES = 8 * 1024 * 1024;

interface ExporterServiceTarget {
  kind: MetricStoreKind;
  service: string;
  port: number;
  path: "/metrics";
}

interface ForwardedExporterTarget extends ExporterServiceTarget {
  url: string;
  pod?: string;
}

interface StoreMetricSampler {
  kind: MetricStoreKind;
  service: string;
  store: string;
  sample(): Promise<string>;
  close(): Promise<void>;
}

export interface StoreMetricCollection {
  targetCount: number;
  exporterCount: number;
  directCount: number;
  sample(source: EmbeddedMetricSource): Promise<string[]>;
  close(): Promise<void>;
}

function exporterKind(service: KubernetesService): MetricStoreKind | undefined {
  const identity = [service.name, ...service.ports.map((port) => port.name ?? "")]
    .join(" ")
    .toLowerCase();
  if (/redis[^ ]*[-_ ]?exporter|exporter[^ ]*[-_ ]?redis/.test(identity)
    || service.ports.some((port) => port.port === 9121)) return "redis";
  if (/mysqld?[^ ]*[-_ ]?exporter|exporter[^ ]*[-_ ]?mysqld?/.test(identity)
    || service.ports.some((port) => port.port === 9104)) return "mysql";
  return undefined;
}

export function discoverStoreExporterServices(
  services: readonly KubernetesService[],
  kinds: ReadonlySet<MetricStoreKind>,
): ExporterServiceTarget[] {
  return services.flatMap((service) => {
    const kind = exporterKind(service);
    if (!kind || !kinds.has(kind)) return [];
    const standardPort = kind === "redis" ? 9121 : 9104;
    const port = service.ports.find((item) => item.port === standardPort)
      ?? service.ports.find((item) => /metrics/i.test(item.name ?? ""))
      ?? (service.ports.length === 1 ? service.ports[0] : undefined);
    return port ? [{ kind, service: service.name, port: port.port, path: "/metrics" as const }] : [];
  });
}

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function labelValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

function labels(values: Record<string, string>): string {
  const entries = Object.entries(values);
  return entries.length
    ? `{${entries.map(([name, value]) => `${name}="${labelValue(value)}"`).join(",")}}`
    : "";
}

function line(name: string, value: number, metricLabels: Record<string, string> = {}): string {
  return `${name}${labels(metricLabels)} ${Number.isFinite(value) ? value : 0}`;
}

function commandStats(value: unknown): Record<string, number> {
  if (typeof value !== "string") return {};
  return Object.fromEntries(value.split(",").flatMap((item) => {
    const separator = item.indexOf("=");
    if (separator < 1) return [];
    const parsed = Number(item.slice(separator + 1));
    return Number.isFinite(parsed) ? [[item.slice(0, separator), parsed]] : [];
  }));
}

export function redisInfoExposition(info: Record<string, unknown>, endpoint: RedisEndpoint): string {
  const instance = `${endpoint.host}:${endpoint.port}`;
  const output = [
    line("redis_up", 1, { instance }),
    line("redis_connected_clients", numberValue(info.connected_clients), { instance }),
    line("redis_blocked_clients", numberValue(info.blocked_clients), { instance }),
    line("redis_memory_used_bytes", numberValue(info.used_memory), { instance }),
    line("redis_memory_used_rss_bytes", numberValue(info.used_memory_rss), { instance }),
    line("redis_evicted_keys_total", numberValue(info.evicted_keys), { instance }),
    line("redis_expired_keys_total", numberValue(info.expired_keys), { instance }),
    line("redis_keyspace_hits_total", numberValue(info.keyspace_hits), { instance }),
    line("redis_keyspace_misses_total", numberValue(info.keyspace_misses), { instance }),
    line("redis_rejected_connections_total", numberValue(info.rejected_connections), { instance }),
    line("redis_doctor_clients", numberValue(info.connected_clients), { instance, state: "connected" }),
    line("redis_doctor_clients", numberValue(info.blocked_clients), { instance, state: "blocked" }),
    line("redis_doctor_memory_bytes", numberValue(info.used_memory), { instance, type: "used" }),
    line("redis_doctor_memory_bytes", numberValue(info.used_memory_rss), { instance, type: "rss" }),
  ];
  for (const [name, value] of Object.entries(info)) {
    if (!name.startsWith("cmdstat_")) continue;
    const cmd = name.slice("cmdstat_".length).toLowerCase();
    const stats = commandStats(value);
    output.push(line("redis_commands_total", stats.calls ?? 0, { instance, cmd }));
    output.push(line("redis_commands_duration_seconds_total", (stats.usec ?? 0) / 1_000_000, { instance, cmd }));
    output.push(line("redis_commands_rejected_calls_total", stats.rejected_calls ?? 0, { instance, cmd }));
    output.push(line("redis_commands_failed_calls_total", stats.failed_calls ?? 0, { instance, cmd }));
  }
  return `${output.join("\n")}\n`;
}

function redisSampler(
  service: string,
  store: ServiceRedisDataSource,
  client: ServiceRedisClient,
): StoreMetricSampler {
  return {
    kind: "redis",
    service,
    store: store.id,
    sample: async () => {
      const topology = await client.topology();
      const samples = await Promise.all(topology.masters.map(async (endpoint) => {
        const connection = await client.access.connection(endpoint, client.target.database);
        return redisInfoExposition(await connection.info(), endpoint);
      }));
      return samples.join("");
    },
    close: async () => {},
  };
}

export function mysqlStatusExposition(rows: readonly Record<string, unknown>[]): string {
  const status = new Map(rows.flatMap((row) => {
    const name = String(row.Variable_name ?? row.variable_name ?? "");
    const value = Number(row.Value ?? row.variable_value);
    return name && Number.isFinite(value) ? [[name, value] as const] : [];
  }));
  const output = [line("mysql_up", 1)];
  for (const metricName of STORE_METRIC_NAMES.mysql) {
    if (!metricName.startsWith("mysql_global_status_")) continue;
    const suffix = metricName.slice("mysql_global_status_".length);
    const variable = [...status.keys()].find((name) => name.toLowerCase() === suffix);
    if (variable) output.push(line(metricName, status.get(variable)!));
  }
  output.push(line("mysql_doctor_threads", status.get("Threads_connected") ?? 0, { state: "connected" }));
  output.push(line("mysql_doctor_threads", status.get("Threads_running") ?? 0, { state: "running" }));
  output.push(line("mysql_doctor_pressure_events_total", status.get("Slow_queries") ?? 0, { event: "slow_queries" }));
  output.push(line("mysql_doctor_pressure_events_total", status.get("Created_tmp_disk_tables") ?? 0, { event: "tmp_disk_tables" }));
  output.push(line("mysql_doctor_pressure_events_total", status.get("Aborted_connects") ?? 0, { event: "aborted_connects" }));
  return `${output.join("\n")}\n`;
}

function mysqlSampler(
  service: string,
  store: { id: string },
  target: DatabaseTarget,
  database: Database,
): StoreMetricSampler {
  return {
    kind: "mysql",
    service,
    store: store.id,
    sample: async () => mysqlStatusExposition(
      await database.query(target, "SHOW GLOBAL STATUS", []),
    ),
    close: async () => undefined,
  };
}

async function prepareDirectSamplers(input: {
  plugin: PluginDefinition;
  commandContext: CommandContext;
  collect: KubernetesCommandConfig;
  services: readonly string[];
  executor: Executor;
}): Promise<{
  samplers: StoreMetricSampler[];
  errors: Array<{ kind: MetricStoreKind; message: string }>;
}> {
  const samplers = new Map<string, StoreMetricSampler>();
  const errors: Array<{ kind: MetricStoreKind; message: string }> = [];
  for (const serviceName of input.services) {
    const service = input.plugin.services.find(serviceName);
    if (!service) continue;
    for (const store of connectionDataSources(service)) {
      try {
        if (store.kind === "redis") {
          const client = await borrowServiceClient(input.commandContext, input.collect, input.executor,
            serviceName, store, store.source);
          samplers.set(`${serviceName}/${store.id}`, redisSampler(serviceName, store, client));
        } else if (store.kind === "db" && store.backend === "mysql") {
          const client = await borrowDatabase(input.commandContext, {
            collect: input.collect, service: serviceName, capability: store,
          }, input.executor);
          const target = client.target;
          const key = ["mysql", target.host, target.port, target.database, target.user].join("|");
          if (!samplers.has(key)) samplers.set(key, mysqlSampler(serviceName, store, client.target, client.database));
        }
      } catch (error) {
        const kind = store.kind === "redis" ? "redis" : "mysql";
        errors.push({
          kind,
          message: store.kind === "db" ? `${serviceName}/${store.id} 数据库 source 初始化失败`
            : `${serviceName}/${store.id} Redis source 初始化失败`,
        });
      }
    }
  }
  return {
    samplers: [...samplers.values()],
    errors,
  };
}

function exporterAliases(kind: MetricStoreKind, body: string): string {
  const samples = parseExposition(body).samples;
  const sum = (name: string): number | undefined => {
    const matched = samples.filter((sample) => sample.name === name);
    return matched.length ? matched.reduce((total, sample) => total + sample.value, 0) : undefined;
  };
  const optionalLine = (
    name: string,
    value: number | undefined,
    metricLabels: Record<string, string>,
  ) => value === undefined ? [] : [line(name, value, metricLabels)];
  if (kind === "redis") {
    return [
      ...optionalLine("redis_doctor_clients", sum("redis_connected_clients"), { state: "connected" }),
      ...optionalLine("redis_doctor_clients", sum("redis_blocked_clients"), { state: "blocked" }),
      ...optionalLine("redis_doctor_memory_bytes", sum("redis_memory_used_bytes"), { type: "used" }),
      ...optionalLine("redis_doctor_memory_bytes", sum("redis_memory_used_rss_bytes"), { type: "rss" }),
    ].join("\n") + "\n";
  }
  return [
    ...optionalLine("mysql_doctor_threads", sum("mysql_global_status_threads_connected"), { state: "connected" }),
    ...optionalLine("mysql_doctor_threads", sum("mysql_global_status_threads_running"), { state: "running" }),
    ...optionalLine("mysql_doctor_pressure_events_total", sum("mysql_global_status_slow_queries"), { event: "slow_queries" }),
    ...optionalLine("mysql_doctor_pressure_events_total", sum("mysql_global_status_created_tmp_disk_tables"), { event: "tmp_disk_tables" }),
    ...optionalLine("mysql_doctor_pressure_events_total", sum("mysql_global_status_aborted_connects"), { event: "aborted_connects" }),
  ].join("\n") + "\n";
}

export function exporterHealthy(kind: MetricStoreKind, body: string): boolean {
  const upName = kind === "redis" ? "redis_up" : "mysql_up";
  return parseExposition(body).samples.some((sample) => sample.name === upName && sample.value === 1);
}

async function responseBody(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (; ;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel("doctor Store exporter response size limit").catch(() => undefined);
      throw new Error(`响应超过 ${limit} bytes`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function scrapeExporter(
  target: ForwardedExporterTarget,
  fetcher: MetricFetch,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("exporter scrape timeout")), timeoutMs);
  try {
    const response = await fetcher(target.url, { signal: controller.signal });
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > EXPORTER_MAX_BODY_BYTES) {
      throw new Error(`响应超过 ${EXPORTER_MAX_BODY_BYTES} bytes`);
    }
    const body = await responseBody(response, EXPORTER_MAX_BODY_BYTES);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!exporterHealthy(target.kind, body)) throw new Error(`${target.kind}_up != 1`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export async function prepareStoreMetricCollection(input: {
  plugin: PluginDefinition;
  commandContext: CommandContext;
  collect: KubernetesCommandConfig;
  services: readonly string[];
  executor: Executor;
  forwarder: ServicePortForwarder;
  namespace: string;
  intervalMs: number;
  fetch?: MetricFetch;
}): Promise<StoreMetricCollection> {
  const network = await listServiceNetwork(input.executor, input.namespace);
  const kinds = new Set<MetricStoreKind>();
  for (const serviceName of input.services) {
    for (const store of connectionDataSources(input.plugin.services.find(serviceName))) {
      if (store.kind === "redis") kinds.add("redis");
      if (store.kind === "db" && store.backend === "mysql") kinds.add("mysql");
    }
  }
  const exporterErrors: string[] = [];
  const exporterTargets = (
    await Promise.all(discoverStoreExporterServices(network.services, kinds).map(async (target) => {
      try {
        const endpoints = await input.forwarder.forwardServiceTargets({ host: target.service, port: target.port });
        return endpoints.map((endpoint): ForwardedExporterTarget => ({
          ...target,
          url: `http://${endpoint.host}:${endpoint.port}${target.path}`,
          pod: endpoint.pod,
        }));
      } catch (error) {
        exporterErrors.push(`${target.service} exporter 访问准备失败：${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    }))
  ).flat();
  let direct: Awaited<ReturnType<typeof prepareDirectSamplers>>;
  try {
    direct = await prepareDirectSamplers(input);
  } catch (error) {
    direct = {
      samplers: [],
      errors: [...kinds].map((kind) => ({
        kind,
        message: `Store 直采准备失败：${error instanceof Error ? error.message : String(error)}`,
      })),
    };
  }
  const samplers = direct.samplers;
  const fetcher = input.fetch ?? fetch;
  const disabledExporterKinds = new Set<MetricStoreKind>();
  return {
    targetCount: exporterTargets.length + samplers.length,
    exporterCount: exporterTargets.length,
    directCount: samplers.length,
    sample: async (source) => {
      const errors: string[] = [...exporterErrors];
      for (const kind of kinds) {
        const kindExporters = disabledExporterKinds.has(kind)
          ? []
          : exporterTargets.filter((item) => item.kind === kind);
        const exporterSamples = await Promise.allSettled(kindExporters.map(async (target) => ({
          target,
          body: await scrapeExporter(
            target,
            fetcher,
            Math.max(500, Math.min(10_000, input.intervalMs)),
          ),
        })));
        const exporterCollected = kindExporters.length > 0
          && exporterSamples.every((result) => result.status === "fulfilled");
        if (exporterCollected) {
          for (const result of exporterSamples) {
            if (result.status !== "fulfilled") continue;
            const { target, body } = result.value;
            const metricLabels = {
              doctor_store_kind: kind,
              doctor_metric_source: "exporter",
              doctor_exporter_service: target.service,
              ...(target.pod ? { pod: target.pod } : {}),
            };
            source.ingest(body, {
              labels: metricLabels,
              metricNames: [...STORE_METRIC_NAMES[kind]],
            });
            source.ingest(exporterAliases(kind, body), { labels: metricLabels });
          }
          continue;
        }
        if (kindExporters.length) disabledExporterKinds.add(kind);
        for (const [index, result] of exporterSamples.entries()) {
          if (result.status === "fulfilled") continue;
          errors.push(`${kindExporters[index]!.service} ${kind} exporter 不可用：${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
        }
        errors.push(...direct.errors.filter((item) => item.kind === kind).map((item) => item.message));
        for (const sampler of samplers.filter((item) => item.kind === kind)) {
          try {
            source.ingest(await sampler.sample(), {
              labels: {
                doctor_service: sampler.service,
                doctor_store: sampler.store,
                doctor_store_kind: kind,
                doctor_metric_source: "direct",
              },
              metricNames: [...STORE_METRIC_NAMES[kind]],
            });
          } catch (error) {
            errors.push(kind === "mysql" ? `${sampler.service}/${sampler.store} MySQL 直采失败`
              : `${sampler.service}/${sampler.store} ${kind} 直采失败：${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      return errors;
    },
    close: async () => {
      await Promise.allSettled(samplers.map((sampler) => sampler.close()));
    },
  };
}

export function selectedMetricStoreKinds(
  catalog: ServiceCatalog,
  services: readonly string[],
): MetricStoreKind[] {
  const kinds = new Set<MetricStoreKind>();
  for (const service of services) {
    for (const store of connectionDataSources(catalog.find(service))) {
      if (store.kind === "redis") kinds.add("redis");
      if (store.kind === "db" && store.backend === "mysql") kinds.add("mysql");
    }
  }
  return [...kinds];
}
