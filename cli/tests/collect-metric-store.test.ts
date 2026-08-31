import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServiceCatalog } from "@compforge/doctor-plugin";
import type { PluginDefinition } from "@compforge/doctor-plugin";
import {
  discoverStoreExporterServices,
  exporterHealthy,
  mysqlStatusExposition,
  redisInfoExposition,
  selectedMetricStoreKinds,
} from "../src/collect/metric/store/collector";
import { resolveMetricConfig } from "../src/collect/metric/config";
import { prepareMetricSource } from "../src/collect/metric/preparation";
import { parseExposition, parsePromQL } from "@compforge/prombed";
import { STORE_METRIC_CAPABILITIES } from "../src/collect/metric/store/contract";
import { CommandContext } from "../src/command";

describe("metric Store observability", () => {
  test("bundle 输出拒绝 HTML/Markdown 后缀", async () => {
    const services = createServiceCatalog([{
      name: "app",
      workloads: [],
      capabilities: {
        metric: {
          endpoint: { host: "test-service", port: 8080, path: "/metrics" },
          metricNames: ["requests_total"],
          charts: [],
        },
      },
    }]);
    await expect(resolveMetricConfig({
      services: "app",
      prometheus: "http://prometheus.example",
      format: "bundle",
      output: "report.html",
    }, services, new CommandContext({}), false)).rejects.toThrow(
      "--format bundle 的输出路径不能使用 .html/.md 后缀",
    );
  });

  test("discovers Redis and MySQL exporter Services by identity and conventional ports", () => {
    const targets = discoverStoreExporterServices([
      {
        kind: "service",
        namespace: "dev",
        name: "prometheus-redis-exporter",
        selector: {},
        ports: [{ name: "metrics", port: 9121 }],
      },
      {
        kind: "service",
        namespace: "dev",
        name: "mysql-metrics",
        selector: {},
        ports: [{ name: "http", port: 9104 }],
      },
      {
        kind: "service",
        namespace: "dev",
        name: "unrelated-metrics",
        selector: {},
        ports: [{ name: "metrics", port: 9090 }],
      },
    ], new Set(["redis", "mysql"]));

    expect(targets).toEqual([
      { kind: "redis", service: "prometheus-redis-exporter", port: 9121, path: "/metrics" },
      { kind: "mysql", service: "mysql-metrics", port: 9104, path: "/metrics" },
    ]);
  });

  test("treats an exporter as usable only when its Store up metric is one", () => {
    expect(exporterHealthy("redis", "redis_up 1\n")).toBe(true);
    expect(exporterHealthy("redis", "redis_up 0\n")).toBe(false);
    expect(exporterHealthy("mysql", "mysql_up 1\n")).toBe(true);
    expect(exporterHealthy("mysql", "process_up 1\n")).toBe(false);
  });

  test("projects Redis INFO into exporter-compatible command and pressure metrics", () => {
    const parsed = parseExposition(redisInfoExposition({
      connected_clients: 9,
      blocked_clients: 2,
      used_memory: 1024,
      used_memory_rss: 2048,
      evicted_keys: 3,
      cmdstat_scan: "calls=12,usec=3000,usec_per_call=250.00,rejected_calls=1,failed_calls=2",
    }, { host: "redis-ha", port: 6379 }));

    expect(parsed.samples).toContainEqual({
      name: "redis_commands_total",
      labels: { instance: "redis-ha:6379", cmd: "scan" },
      value: 12,
    });
    expect(parsed.samples).toContainEqual({
      name: "redis_commands_duration_seconds_total",
      labels: { instance: "redis-ha:6379", cmd: "scan" },
      value: 0.003,
    });
    expect(parsed.samples).toContainEqual({
      name: "redis_doctor_clients",
      labels: { instance: "redis-ha:6379", state: "blocked" },
      value: 2,
    });
    expect(parsed.samples).toContainEqual({
      name: "redis_commands_failed_calls_total",
      labels: { instance: "redis-ha:6379", cmd: "scan" },
      value: 2,
    });
  });

  test("projects SHOW GLOBAL STATUS into mysqld_exporter-compatible metrics", () => {
    const rows = Object.entries({
      Queries: 1000,
      Threads_connected: 17,
      Threads_running: 4,
      Slow_queries: 6,
      Created_tmp_disk_tables: 8,
      Aborted_connects: 2,
    }).map(([Variable_name, Value]) => ({ Variable_name, Value: String(Value) }));
    const parsed = parseExposition(mysqlStatusExposition(rows));

    expect(parsed.samples).toContainEqual({ name: "mysql_global_status_queries", labels: {}, value: 1000 });
    expect(parsed.samples).toContainEqual({
      name: "mysql_doctor_threads",
      labels: { state: "running" },
      value: 4,
    });
    expect(parsed.samples).toContainEqual({
      name: "mysql_doctor_pressure_events_total",
      labels: { event: "slow_queries" },
      value: 6,
    });
  });

  test("limits Store metric collection to selected Service dependencies", () => {
    const catalog = createServiceCatalog([
      {
        name: "chat-server",
        workloads: [],
        capabilities: {
          stores: [
            { id: "redis", kind: "redis" as const, backend: "redis" as const, environment: { address: "REDIS_HOST" } },
            { id: "database", kind: "db" as const, backend: "mysql" as const, envPrefix: "DB" },
          ],
        },
      },
      {
        name: "unrelated-server",
        workloads: [],
        capabilities: {
          stores: [{ id: "redis", kind: "redis" as const, backend: "redis" as const, environment: { address: "REDIS_HOST" } }],
        },
      },
    ]);

    expect(selectedMetricStoreKinds(catalog, ["chat-server"])).toEqual(["redis", "mysql"]);
    expect(selectedMetricStoreKinds(catalog, ["unrelated-server"])).toEqual(["redis"]);
  });

  test("keeps every Store chart within Prombed's supported PromQL subset", () => {
    for (const capability of Object.values(STORE_METRIC_CAPABILITIES)) {
      for (const chart of capability.charts) {
        expect(() => parsePromQL(chart.query.instant)).not.toThrow();
        expect(() => parsePromQL(chart.query.range.replaceAll("{{window}}", "10s"))).not.toThrow();
      }
    }
  });

  test("keeps remote Service and Store queries usable when the selected profile has no kubeconfig", async () => {
    const services = createServiceCatalog([{
      name: "app",
      workloads: [],
      capabilities: {
        stores: [{
          id: "redis",
          kind: "redis" as const,
          backend: "redis" as const,
          environment: { address: "REDIS_HOST" },
        }],
        metric: {
          endpoint: { host: "test-service", port: 8080, path: "/metrics" },
          metricNames: ["requests_total"],
          charts: [],
        },
      },
    }]);
    const plugin = { id: "example", version: "0.0.1", services } as PluginDefinition;
    const directory = mkdtempSync(join(tmpdir(), "doctor-metric-remote-store-"));
    const configPath = join(directory, "config.yaml");
    writeFileSync(configPath, [
      "profiles:",
      "  prometheus-only:",
      "    readonly: true",
      "    prometheus:",
      "      url: http://prometheus.example",
      "default_profile: prometheus-only",
      "",
    ].join("\n"));
    try {
      const commandContext = new CommandContext({}, {
        name: "prometheus-only",
        configPath,
        value: {
          readonly: true,
          prometheus: { url: "http://prometheus.example" },
        },
        pluginConfig: {},
      });
      const config = await resolveMetricConfig({
        config: configPath,
        profile: "prometheus-only",
        services: "app",
      }, services, commandContext, false);
      expect(config?.storeSupplementUnavailableReason).toContain("未配置 kube.kubeconfig_path");
      const preparation = await prepareMetricSource(config!, plugin, commandContext);
      expect(preparation.sourceKind).toBe("remote");
      expect(preparation.storeFallbackReason).toContain("未配置 kube.kubeconfig_path");
      expect(preparation.storeSource).toBeUndefined();
      await preparation.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
