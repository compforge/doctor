import { expect, test } from "bun:test";
import { createServiceCatalog, type ServiceDefinition } from "@compforge/doctor-plugin";
import type { OpenSearchReadApi } from "../src/infra/search/opensearch";
import { OPENSEARCH_HEALTH_EXTENSION } from "../src/plugin/builtins";
import { DataSourceHealthSession } from "../src/datasource/health/session";
import { createDoctorExtensionRegistry } from "../src/plugin/extension-registry";
import { healthProviders } from "../src/health/extensions";
import { runHealthSession } from "../src/health/flow";
import { buildHealthHtml } from "../src/health/report";

function fixture(percent = 93) {
  const calls: string[] = [];
  const responses: Record<string, unknown> = {
    "/_cluster/health": { status: "red", unassigned_shards: 1 },
    "/_cat/allocation": [{ node: "data-0", "disk.used": percent, "disk.avail": 100 - percent,
      "disk.total": 100, "disk.percent": percent },
      { node: "UNASSIGNED", "disk.used": null, "disk.avail": null, "disk.total": null, "disk.percent": null }],
    "/_cluster/settings": { defaults: {
      "cluster.routing.allocation.disk.watermark.low": "85%",
      "cluster.routing.allocation.disk.watermark.high": "90%",
      "cluster.routing.allocation.disk.watermark.flood_stage": "95%",
    } },
    "/_all/_settings": {},
    "/_cat/shards": [{ state: "UNASSIGNED", prirep: "p" }],
    "/_cluster/stats": { indices: {} },
  };
  const search: OpenSearchReadApi = { count: async () => 0, search: async () => ({}),
    request: async path => { calls.push(path); return responses[path]; } };
  return { search, calls };
}

test("Core registers one OpenSearch builtin without a Plugin or target access", () => {
  const providers = createDoctorExtensionRegistry().extensions("datasource.health", "core");
  expect(providers).toHaveLength(1);
  expect(providers[0]!.origin).toBe("core");
  expect(providers[0]!.service).toBeUndefined();
});

test("93 percent plus unavailable primary is collected evidence, not a false missing-trace verdict", async () => {
  const { search, calls } = fixture();
  const session = new DataSourceHealthSession();
  const [health, again] = await Promise.all([session.probe(search), session.probe(search)]);
  expect(again).toBe(health);
  expect(calls).toHaveLength(6);
  expect(health.status).toBe("ok");
  expect(health.findings.map(finding => finding.kind)).toContain("vdb.disk-capacity-high");
  expect(health.findings.map(finding => finding.kind)).toContain("vdb.unassigned-primary-shards");
  expect(health.findings.map(finding => finding.kind)).not.toContain("vdb.disk-capacity-exhausted");
  const allocation = health.observations.find(item => item.kind === "opensearch-allocation");
  expect(allocation?.nodes[1]?.diskAvailableBytes).toBeUndefined();
  await new DataSourceHealthSession().probe(search);
  expect(calls).toHaveLength(12);
});

test("low watermark warns before high watermark is reached", async () => {
  const health = await OPENSEARCH_HEALTH_EXTENSION.run({ search: fixture(86).search });
  expect(health.findings.map(finding => finding.kind)).toContain("vdb.disk-capacity-low");
  expect(health.findings.map(finding => finding.kind)).not.toContain("vdb.disk-capacity-high");
});

test("permissions and malformed responses remain evidence gaps while sibling probes succeed", async () => {
  const { search } = fixture();
  const request = search.request;
  search.request = async path => {
    if (path === "/_cluster/settings") throw new Error("403 Forbidden");
    if (path === "/_cluster/health") return {};
    return request(path);
  };
  const health = await OPENSEARCH_HEALTH_EXTENSION.run({ search });
  expect(health.status).toBe("partial");
  expect(health.probes.find(probe => probe.id === "cluster-settings")?.reason).toContain("403");
  expect(health.observations.some(item => item.kind === "opensearch-health")).toBe(false);
  expect(health.findings.find(item => item.kind === "vdb.disk-capacity-high")?.confidence).toBe("medium");
});

test("deadline stops subsequent requests and preserves unavailable outcomes", async () => {
  const { search, calls } = fixture();
  search.request = async path => { calls.push(path); return new Promise(() => {}); };
  const health = await OPENSEARCH_HEALTH_EXTENSION.run({ search, timeoutMs: 20 });
  expect(health.status).toBe("unavailable");
  expect(calls).toHaveLength(1);
  expect(health.probes).toHaveLength(6);
  expect(health.findings).toEqual([]);
});

test("Health includes DataSource owners and declared consumers without selecting unrelated stores", async () => {
  const service = (name: string): ServiceDefinition => ({ name, workloads: [],
    component: { name, repository: { forge: { name: "fixture" }, path: name } } });
  const owner = { ...service("collector"), dataSources: [{ id: "trace", kind: "vdb" as const,
    backend: "opensearch" as const, store: "opensearch" }] };
  const consumer = { ...service("search"), dependencies: [{ id: "trace-store", service: "collector", dataSource: "trace" }] };
  const plugin = { id: "fixture", version: "1", services: createServiceCatalog([owner, consumer, service("unrelated")]) };
  expect(healthProviders(plugin).map(provider => provider.name)).toEqual(["collector", "search"]);
  const selected = healthProviders(plugin, ["search"]);
  expect(selected[0]?.dataSources).toEqual([{ service: "collector", dataSource: "trace" }]);
  const health = await OPENSEARCH_HEALTH_EXTENSION.run({ search: fixture().search });
  const result = await runHealthSession(selected, { window: { from: "2026-10-16T00:00:00Z", to: "2026-10-16T01:00:00Z" }, maxEntries: 10 }, {
    summarize: async () => { throw new Error("must not query statistics"); },
    cases: async () => { throw new Error("must not run Cases"); },
    dataSources: async () => [{ service: "collector", dataSource: "trace", evidence: { target: {}, health } }],
    show: () => {},
  });
  expect(result.providers[0]?.dataSources?.[0]?.evidence?.health.status).toBe("ok");
  expect(buildHealthHtml(result)).toContain("high 水位 90%");
});

test("missing watermarks are unknown, never parsed as zero; unrelated settings are not retained", async () => {
  const { search } = fixture(67);
  const request = search.request;
  search.request = async path => path === "/_cluster/settings"
    ? { persistent: { "unrelated.password": "must-not-be-persisted" } } : request(path);
  const health = await OPENSEARCH_HEALTH_EXTENSION.run({ search });
  expect(health.status).toBe("partial");
  expect(health.summary).toContain("未取得实时水位");
  expect(health.summary).toContain("90%");
  expect(health.findings.some(finding => finding.kind.startsWith("vdb.disk-capacity"))).toBe(false);
  expect(JSON.stringify(health)).not.toContain("must-not-be-persisted");
});
