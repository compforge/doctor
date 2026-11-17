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
  const observationIds = new Set<string>(health.observations.map(item => item.id));
  for (const finding of health.findings) {
    expect(finding.schemaVersion).toBe(1);
    expect(finding.producer.origin).toBe("core");
    for (const evidence of finding.evidence) expect(observationIds.has(evidence.observationId)).toBe(true);
  }
  expect(health.findings.map(finding => finding.kind)).toContain("opensearch.disk-capacity-high");
  expect(health.findings.map(finding => finding.kind)).toContain("opensearch.unassigned-primary-shards");
  expect(health.findings.map(finding => finding.kind)).not.toContain("opensearch.disk-capacity-exhausted");
  const allocation = health.observations.find(item => item.kind === "opensearch-allocation");
  expect(allocation?.nodes[1]?.diskAvailableBytes).toBeUndefined();
  await new DataSourceHealthSession().probe(search);
  expect(calls).toHaveLength(12);
});

test("low watermark warns before high watermark is reached", async () => {
  const health = await OPENSEARCH_HEALTH_EXTENSION.run({ search: fixture(86).search });
  expect(health.findings.map(finding => finding.kind)).toContain("opensearch.disk-capacity-low");
  expect(health.findings.map(finding => finding.kind)).not.toContain("opensearch.disk-capacity-high");
});

test("permissions and malformed responses remain evidence gaps while sibling probes succeed", async () => {
  const { search } = fixture();
  const request = search.request;
  search.request = async path => {
    if (path === "/_cluster/settings") throw Object.assign(new Error("secret"), { statusCode: 403 });
    if (path === "/_cluster/health") return {};
    return request(path);
  };
  const health = await OPENSEARCH_HEALTH_EXTENSION.run({ search });
  expect(health.status).toBe("partial");
  expect(health.probes.find(probe => probe.id === "cluster-settings")?.reason).toContain("403");
  expect(health.observations.some(item => item.kind === "opensearch-health")).toBe(false);
  expect(health.findings.find(item => item.kind === "opensearch.disk-capacity-high")?.confidence).toBe("medium");
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


test("missing watermarks are unknown, never parsed as zero; unrelated settings are not retained", async () => {
  const { search } = fixture(67);
  const request = search.request;
  search.request = async path => path === "/_cluster/settings"
    ? { persistent: { "unrelated.password": "must-not-be-persisted" } } : request(path);
  const health = await OPENSEARCH_HEALTH_EXTENSION.run({ search });
  expect(health.status).toBe("partial");
  expect(health.summary).toContain("未取得实时水位");
  expect(health.summary).toContain("90%");
  expect(health.findings.some(finding => finding.kind.startsWith("opensearch.disk-capacity"))).toBe(false);
  expect(JSON.stringify(health)).not.toContain("must-not-be-persisted");
});
