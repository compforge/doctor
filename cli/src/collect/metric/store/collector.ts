import { parseExposition } from "@compforge/prombed";
import type {
  PluginDefinition,
  ServiceCatalog,
  ServiceDatabaseStoreCapability,
  ServiceRedisStoreCapability,
} from "@compforge/doctor-plugin";
import { MysqlDatabase, parseMysqlEnvTarget } from "../../../infra/database/mysql";
import type { DatabaseTarget } from "../../../infra/database";
import type { Executor, ExecTarget } from "../../../infra/k8s/executor";
import type { ServicePortForwarder } from "../../../infra/k8s/service-port-forward";
import {
  findPodsForService,
  listServiceNetwork,
  type KubernetesService,
} from "../../../infra/k8s/service";
import type { KubernetesPod } from "../../../infra/k8s/pod";
import type { EmbeddedMetricSource, MetricFetch } from "../../../infra/metric";
import {
  discoverRedisTopology,
  RedisAccess,
  type RedisEndpoint,
  type RedisTopology,
} from "../../../infra/redis";
import { configuredValue, loadServiceRuntimeConfig } from "../../store/runtime-config";
import {
  hasRedisStoreConfiguration,
  resolveRedisTarget,
  type RedisTarget,
} from "../../redis/fact/target";
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

function environmentText(environment: ReadonlyMap<string, string>): string {
  return [...environment].map(([name, value]) => `${name}=${value}`).join("\n");
}

function mysqlConfigurationComplete(
  environment: Map<string, string>,
  capability: ServiceDatabaseStoreCapability,
): boolean {
  const prefix = capability.envPrefix;
  return !!(
    configuredValue(environment, `${prefix}_HOST`)
    && (configuredValue(environment, `${prefix}_DATABASE`) || configuredValue(environment, `${prefix}_NAME`))
    && (configuredValue(environment, `${prefix}_USERNAME`) || configuredValue(environment, `${prefix}_USER`))
    && configuredValue(environment, `${prefix}_PASSWORD`)
  );
}

async function runtimeEnvironment(
  executor: Executor,
  pod: KubernetesPod,
  complete: (environment: Map<string, string>) => boolean,
): Promise<{ target: ExecTarget; raw: string } | undefined> {
  for (const container of pod.containers) {
    const target = { pod: pod.name, container: container.name };
    const runtime = await loadServiceRuntimeConfig(executor, target, complete);
    if (complete(runtime.environment)) return { target, raw: environmentText(runtime.environment) };
  }
  return undefined;
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
  store: ServiceRedisStoreCapability,
  target: RedisTarget,
  forwarder: ServicePortForwarder,
): StoreMetricSampler {
  const access = new RedisAccess(
    (endpoint) => forwarder.forward(endpoint),
    {
      username: target.username,
      password: target.password,
      useSsl: target.useSsl,
      timeoutMs: target.timeout * 1_000,
    },
  );
  let topology: RedisTopology | undefined;
  return {
    kind: "redis",
    service,
    store: store.id,
    sample: async () => {
      topology ??= await discoverRedisTopology(access, {
        endpoints: target.endpoints.map(([host, port]) => ({ host, port })),
        database: target.database,
        username: target.username,
        password: target.password,
        clusterType: target.clusterType,
        sentinelHosts: target.sentinelHosts.map(([host, port]) => ({ host, port })),
        sentinelMasterName: target.sentinelMasterName,
        sentinelUsername: target.sentinelUsername,
        sentinelPassword: target.sentinelPassword,
      });
      const samples = await Promise.all(topology.masters.map(async (endpoint) => {
        const client = await access.connection(endpoint, target.database);
        return redisInfoExposition(await client.info(), endpoint);
      }));
      return samples.join("");
    },
    close: () => access.close(),
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
  store: ServiceDatabaseStoreCapability,
  target: DatabaseTarget,
  database: MysqlDatabase,
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

function targetKey(kind: MetricStoreKind, target: RedisTarget | DatabaseTarget): string {
  if (kind === "redis") {
    const redis = target as RedisTarget;
    return [kind, redis.clusterType, redis.endpoints.join(","), redis.database, redis.username ?? ""].join("|");
  }
  const mysql = target as DatabaseTarget;
  return [kind, mysql.host, mysql.port, mysql.database, mysql.user].join("|");
}

async function prepareDirectSamplers(input: {
  plugin: PluginDefinition;
  services: readonly string[];
  executor: Executor;
  forwarder: ServicePortForwarder;
  networkServices: readonly KubernetesService[];
  pods: readonly KubernetesPod[];
}): Promise<{
  samplers: StoreMetricSampler[];
  errors: Array<{ kind: MetricStoreKind; message: string }>;
  close(): Promise<void>;
}> {
  const samplers = new Map<string, StoreMetricSampler>();
  const errors: Array<{ kind: MetricStoreKind; message: string }> = [];
  const mysql = new MysqlDatabase((endpoint) => input.forwarder.forward(endpoint), {
    connectTimeoutMs: 10_000,
    queryTimeoutMs: 15_000,
  });
  for (const serviceName of input.services) {
    const service = input.plugin.services.findWith(serviceName, "stores");
    if (!service) continue;
    const namespace = input.networkServices.find((item) => item.name === serviceName)?.namespace
      ?? input.pods[0]?.namespace
      ?? "";
    const pod = findPodsForService(input.networkServices, input.pods, serviceName, namespace)[0];
    if (!pod) {
      for (const store of service.capabilities.stores) {
        if (store.kind === "redis") {
          errors.push({ kind: "redis", message: `${serviceName} 没有可用于解析 Store 配置的 Running Pod` });
        } else if (store.kind === "db" && store.backend === "mysql") {
          errors.push({ kind: "mysql", message: `${serviceName} 没有可用于解析 Store 配置的 Running Pod` });
        }
      }
      continue;
    }
    for (const store of service.capabilities.stores) {
      try {
        if (store.kind === "redis") {
          const runtime = await runtimeEnvironment(
            input.executor,
            pod,
            (environment) => hasRedisStoreConfiguration(environmentText(environment), store),
          );
          if (!runtime) {
            errors.push({ kind: "redis", message: `${serviceName}/${store.id} 未解析出 Redis 运行时配置` });
            continue;
          }
          const target = resolveRedisTarget(runtime.raw, undefined, undefined, store);
          const key = targetKey("redis", target);
          if (!samplers.has(key)) samplers.set(key, redisSampler(serviceName, store, target, input.forwarder));
        } else if (store.kind === "db" && store.backend === "mysql") {
          const runtime = await runtimeEnvironment(
            input.executor,
            pod,
            (environment) => mysqlConfigurationComplete(environment, store),
          );
          if (!runtime) {
            errors.push({ kind: "mysql", message: `${serviceName}/${store.id} 未解析出 MySQL 运行时配置` });
            continue;
          }
          const target = parseMysqlEnvTarget(runtime.raw, { label: serviceName, prefix: store.envPrefix });
          const key = targetKey("mysql", target);
          if (!samplers.has(key)) samplers.set(key, mysqlSampler(serviceName, store, target, mysql));
        }
      } catch (error) {
        const kind = store.kind === "redis" ? "redis" : "mysql";
        errors.push({
          kind,
          message: `${serviceName}/${store.id} Store 配置解析失败：${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }
  return {
    samplers: [...samplers.values()],
    errors,
    close: () => mysql.close(),
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
  for (;;) {
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
    for (const store of input.plugin.services.findWith(serviceName, "stores")?.capabilities.stores ?? []) {
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
    direct = await prepareDirectSamplers({
      ...input,
      networkServices: network.services,
      pods: network.pods,
    });
  } catch (error) {
    direct = {
      samplers: [],
      errors: [...kinds].map((kind) => ({
        kind,
        message: `Store 直采准备失败：${error instanceof Error ? error.message : String(error)}`,
      })),
      close: async () => undefined,
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
            errors.push(`${sampler.service}/${sampler.store} ${kind} 直采失败：${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      return errors;
    },
    close: async () => {
      await Promise.allSettled(samplers.map((sampler) => sampler.close()));
      await direct.close();
    },
  };
}

export function selectedMetricStoreKinds(
  catalog: ServiceCatalog,
  services: readonly string[],
): MetricStoreKind[] {
  const kinds = new Set<MetricStoreKind>();
  for (const service of services) {
    for (const store of catalog.findWith(service, "stores")?.capabilities.stores ?? []) {
      if (store.kind === "redis") kinds.add("redis");
      if (store.kind === "db" && store.backend === "mysql") kinds.add("mysql");
    }
  }
  return [...kinds];
}
