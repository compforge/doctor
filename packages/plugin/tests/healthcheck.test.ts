import { expect, test } from "bun:test";
import { HEALTH_SCOPES, healthCheckScope, requireHealthCheckExtension, validateHealthProbeResult, withSummary, type HealthProbeExtension } from "../src";
const check: HealthProbeExtension = { id: "database", kind: "healthcheck.infra", execution: "probe", description: "DB readiness", access: {},
  approval: { risk: "observe", target: "db", impact: ["SELECT 1"] }, run: withSummary({ title: "DB", fields: [] }, async () => ({ status: "passed", summary: "query succeeded" })) };
test("HealthCheck scope comes only from its kind and probe approval is required", () => {
  for (const scope of HEALTH_SCOPES) expect(healthCheckScope(requireHealthCheckExtension({ ...check, kind: `healthcheck.${scope}` }))).toBe(scope);
  for (const patch of [{ kind: "health.case.bindings" }, { execution: "legacy" }, { approval: undefined }, { description: "" }]) {
    expect(() => requireHealthCheckExtension({ ...check, ...patch } as never)).toThrow();
  }
});
test("probe evidence must be JSON-safe, bounded and include an explicit verdict", () => {
  expect(() => validateHealthProbeResult({ status: "passed", summary: "ok", evidence: { code: "200" } })).not.toThrow();
  for (const value of [{ status: "ok", summary: "ok" }, { status: "passed", summary: "" },
    { status: "passed", summary: "ok", evidence: { secretFunction: () => {} } },
    { status: "passed", summary: "ok", evidence: { body: "x".repeat(128 * 1024) } }]) {
    expect(() => validateHealthProbeResult(value as never)).toThrow();
  }
});


test("DataSource checks declare a probe identity and JSON-safe parameters", () => {
  const source = async () => ({ kind: "mysql", id: () => "db", clientKey: "db", createClient: () => ({ initialize: async () => {}, dispose: async () => {} }) });
  const configured: HealthProbeExtension = { ...check, dataSource: source, probe: "mysql.connectivity@1", parameters: { timeoutMs: 1000 } };
  expect(() => requireHealthCheckExtension(configured)).not.toThrow();
  for (const patch of [{ dataSource: source }, { dataSource: source, probe: " " }, { dataSource: true, probe: "db" },
    { dataSource: source, probe: "db", parameters: { invalid: () => {} } }]) {
    expect(() => requireHealthCheckExtension({ ...check, ...patch } as never)).toThrow();
  }
});
