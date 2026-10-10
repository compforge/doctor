import { expect, test } from "bun:test";
import { normalizeServiceInspectResult } from "../src/plugin/inspect";
import { normalizeInspectSources, boundInspectSources } from "../src/plugin/inspect-sources";
import { buildDataCoverage, projectDataServiceEvidence, makeDataDetectors } from "../src/collect/data/detector";
import { buildDataHtml } from "../src/collect/data/render";
import { collectedFact } from "../src/collect/protocol";
import { runDetectors } from "../src/collect/detector-engine";
import { createServiceCatalog, type ServiceInspectSource } from "@compforge/doctor-plugin";
import type { DataEvidence } from "../src/collect/data";

const identity = { kind: "record_id", value: "r1" };
const resolution = { inputId: "r1", resolvedAs: "record_id", identifiers: {} };
const source: ServiceInspectSource = { source: "objects", subject: identity, status: "not_found" };
function evidence(sources: ServiceInspectSource[]): DataEvidence {
  return { observations: [], facts: {
    services: { sample: { inspect: collectedFact("data.inspect-capability", "test", { queryable: true }) } },
    capabilityResults: [{ ...collectedFact("data.inspect-result", "test", { result: { resolution, facts: [], sources } }),
      id: "q1", service: "sample", stage: "provide", identity }],
  } };
}

test("Source outcomes survive normalization separately from domain Facts", () => {
  const sources: ServiceInspectSource[] = [source,
    { source: "db", status: "failed", reason: "denied", errorKind: "permission_denied", errorCode: 403 },
    { source: "logs", status: "not_collected", reason: "budget" }];
  const result = normalizeServiceInspectResult({ service: "sample", queryIdentity: identity,
    capability: { provides: [], expands: [] }, budget: { maxFacts: 10, maxBytes: 10000 },
    value: { resolution, facts: [], sources } });
  expect(result.sources).toEqual(sources);
  expect(result.facts).toEqual([]);
  for (const invalid of [{ source: "db", status: "collected", subject: null }, { source: "db", status: "missing" }, { source: "db", status: "failed" }, { source: "db", status: "not_collected", reason: "" }]) {
    expect(() => normalizeInspectSources([invalid], "sample")).toThrow();
  }
});

test("Source metadata shares Fact count and byte budgets", () => {
  const result = normalizeServiceInspectResult({ service: "sample", queryIdentity: identity,
    capability: { provides: ["sample"], expands: [] }, budget: { maxFacts: 1, maxBytes: 10000 },
    value: { resolution, sources: [source, { ...source, source: "other" }], facts: [{ factType: "value", kind: "sample", schemaVersion: 1, value: true }] } });
  expect(result.sources).toHaveLength(1);
  expect(result.facts).toHaveLength(0);
  expect(result.truncated?.reason).toContain("source outcome");
  expect(boundInspectSources([source], { maxFacts: 10, maxBytes: 1 }).omitted).toBe(1);
});

test("Confirmed absence is complete evidence, failures and unperformed reads are gaps", () => {
  expect(buildDataCoverage(evidence([source]))[0]?.status).toBe("sufficient");
  for (const status of ["failed", "not_collected"] as const) {
    const coverage = buildDataCoverage(evidence([{ source: "db", status, reason: "reason" }]))[0]!;
    expect(coverage.status).toBe("partial");
    expect(coverage.missingEvidence.join()).toContain(status === "failed" ? "查询失败" : "未采集");
  }
});

test("Plugin detectors can cite acquisition evidence through existing evidence paths", () => {
  const input = evidence([source]);
  const projected = projectDataServiceEvidence(input, "test");
  expect(projected.sources?.[0]?.result.status).toBe("not_found");
  const catalog = createServiceCatalog([{ name: "sample", workloads: [],
    component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures" } },
    detectors: [{ id: "absence", detect: data => [{ id: "missing", kind: "missing", schemaVersion: 1,
      severity: "info", confidence: "high", message: "expected cleanup", evidence: [{ factPath: data.sources![0]!.factPath, role: "supporting" }] }] }],
  }]);
  expect(runDetectors(makeDataDetectors("test", catalog, ["sample"]), input)).toHaveLength(1);
  const html = buildDataHtml({ evidence: input, findings: [], coverage: buildDataCoverage(input) });
  expect(html).toContain("确认不存在");
});
