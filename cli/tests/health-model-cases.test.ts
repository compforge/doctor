import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServiceCatalog, kubernetesServiceWorkload, modelHttpCases, withSummary,
  type CaseProduceExtension, type CaseModelType, type Model, type WorkloadInstance } from "@compforge/doctor-plugin";
import { inspectCaseModel } from "../src/case/model-check";
import { prepareServiceCases } from "../src/health/case-prepare";
import { checkServiceCases } from "../src/health/cases";
import { buildHealthHtml } from "../src/health/report";

test("model response checks reject HTTP-200 error envelopes and unusable results without judging answers", () => {
  const examples: Array<{ type: CaseModelType; valid: unknown; invalid: unknown[] }> = [
    { type: "llm", valid: { choices: [{ message: { role: "assistant", content: "Any substantive reply" } }] },
      invalid: [{ choices: [] }, { choices: [{ message: { role: "assistant", content: " " } }] },
        { choices: [{ message: { role: "user", content: "echo" } }] }] },
    { type: "embedding", valid: { data: [{ embedding: [0.1, -0.2, 0] }] },
      invalid: [{ data: [] }, { data: [{ embedding: [] }] }, { data: [{ embedding: ["invalid"] }] }] },
    { type: "rerank", valid: { results: [{ index: 0, relevance_score: 0.9 }] },
      invalid: [{ results: [] }, { results: [{ index: -1, relevance_score: 0.9 }] }, { results: [{ index: 0 }] }] },
  ];
  for (const example of examples) {
    expect(inspectCaseModel(JSON.stringify(example.valid), example.type).errors).toEqual([]);
    for (const invalid of [...example.invalid, null, [], {}, { error: { message: "secret provider detail" } }]) {
      const result = inspectCaseModel(JSON.stringify(invalid), example.type);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(JSON.stringify(result)).not.toContain("secret provider detail");
    }
    expect(inspectCaseModel("not json", example.type).errors).toEqual(["Model response is not valid JSON"]);
  }
});

const model: Model = { id: "catalog-id", name: "Example", type: "llm", provider: "example",
  inference: { baseUrl: "http://inference.test/v1", model: "runtime-model-id" } };
const producer: CaseProduceExtension = { id: "models", kind: "case.produce", access: {},
  requestTenant: { configured: () => undefined },
  run: withSummary({ title: "Model Cases", fields: [] }, async () => ({ cases: modelHttpCases(model) })) };
const component = { name: "test", repository: { forge: { name: "test" }, path: "test" } };
const binding = { id: "models", workload: "main", producer: { service: "catalog", source: "models" } };
const consume = { id: "requests", kind: "health.cases" as const, access: {},
  run: withSummary({ title: "Requests", fields: [] }, async () => ({ bindings: [binding] })) };
const consumer = { name: "worker", component, workloads: [kubernetesServiceWorkload("worker")], extensions: [consume] };
const source = { name: "catalog", component, workloads: [], cases: [{ id: producer.id, load: () => [], produce: producer }] };
const plugin = { id: "test", version: "1", services: createServiceCatalog([consumer, source]) };
const target: WorkloadInstance = { platform: "kubernetes", environment: "test", workload: "main", namespace: "test", pod: "worker-1", uid: "uid-1", container: "app" };

test("Health prepares only the tenant; producer owns model choice and consumer owns execution location", async () => {
  const signal = new AbortController().signal;
  const directory = mkdtempSync(join(tmpdir(), "health-model-cases-"));
  const calls: string[] = [];
  const prepared = await prepareServiceCases(plugin, consumer, [consume], undefined, {
    signal, consume: async () => { calls.push("consume"); return { bindings: [binding] }; },
    identity: async () => { throw new Error("Model probes must not select a user"); },
    tenant: async () => { calls.push("tenant"); return "probe-tenant"; },
  });
  expect(calls).toEqual(["consume", "tenant"]);
  expect(prepared[0]!.execution!.query).toEqual({ tenantId: undefined, requestIdentity: undefined, requestTenantId: "probe-tenant", maxCases: 10 });
  try {
    let sent = 0;
    const result = await checkServiceCases(prepared, {
      signal, directory, checkpoint: () => {}, targets: async () => ({ targets: [target] }),
      produce: async (service, extension, query) => {
        expect(service.name).toBe(source.name);
        expect(extension.run).toBe(producer.run);
        expect(query.requestTenantId).toBe("probe-tenant");
        calls.push("produce");
        return { cases: modelHttpCases(model) };
      },
      approve: async () => { calls.push("approve"); return { approved: true, source: "assume-yes" }; },
      sender: async instance => {
        expect(instance).toEqual(target);
        return async request => {
          calls.push("send");
          expect(request.url).toBe("http://inference.test/v1/chat/completions");
          expect(JSON.parse(new TextDecoder().decode(request.body)).model).toBe("runtime-model-id");
          const body = ++sent === 2 ? { error: { message: "unsupported adjacent roles" } }
            : { choices: [{ message: { role: "assistant", content: "OK" } }] };
          return { statusCode: 200, statusText: "OK", headers: { "content-type": "application/json" }, body: new Response(JSON.stringify(body)).body };
        };
      },
    });
    expect(calls).toEqual(["consume", "tenant", "produce", "approve", "send", "approve", "send", "approve", "send"]);
    expect(result[0]!.status).toBe("failed");
    expect(result[0]!.attempts.map(attempt => attempt.status)).toEqual(["passed", "failed", "passed"]);
    expect(result[0]!.attempts[1]!.modelCheck?.errors).toEqual(["Model response contains an error"]);
    expect(JSON.stringify(result)).not.toContain("probe-tenant");
    const html = buildHealthHtml({ query: { window: { from: "2026-01-01", to: "2026-01-02" }, maxEntries: 10 },
      providers: [{ namespace: "plugin/test/service/worker", name: "worker", facets: [], cases: result }] });
    expect(html).toContain("Model response contains an error");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("missing or cancelled tenant never enters consumer Pods or invokes producers", async () => {
  for (const failure of [true, false]) {
    const signal = new AbortController().signal;
    const prepared = await prepareServiceCases(plugin, consumer, [consume], undefined, {
      signal, consume: async () => ({ bindings: [binding] }), identity: async () => undefined,
      tenant: async () => { if (failure) throw new Error("missing tenant"); return undefined; },
    });
    expect(prepared[0]!.execution).toBeUndefined();
    const result = await checkServiceCases(prepared, {
      signal, directory: "/unused", checkpoint: () => {},
      targets: async () => { throw new Error("must not enter target"); },
      sender: async () => { throw new Error("must not prepare sender"); },
      produce: async () => { throw new Error("must not produce"); },
      approve: async () => { throw new Error("must not approve"); },
    });
    expect(result[0]).toMatchObject({ stage: "identity", status: failure ? "unavailable" : "cancelled", targets: [], attempts: [] });
  }
});
