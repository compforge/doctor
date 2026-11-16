import { withSummary, type CaseProduceResult, type HealthCaseExtension, type ServiceCaseSource } from "@compforge/doctor-plugin";

const ping: CaseProduceResult["cases"][number]["case"] = {
  id: "api_health", desc: "API health endpoint is reachable",
  input: { protocol: "http", method: "GET", path: "/health" },
  judge: { e2e: { http: { status: [200] } } },
};

export const apiCases: ServiceCaseSource = {
  id: "connectivity", description: "Shared API connectivity Cases",
  load: () => [{ caseset: "example_api", schema_version: 1, cases: [ping] }],
  produce: {
    access: {},
    run: withSummary({ title: "API Cases", fields: [] }, async () => ({
      cases: [{ case: ping, targets: [{ id: "service", url: "http://example-api:8080/health" }] }],
    })),
  },
};

export const workerHealthCases: HealthCaseExtension = {
  id: "api-connectivity", kind: "healthcheck.deps", execution: "cases", description: "Worker API connectivity", access: {},
  run: withSummary({ title: "Worker dependencies", fields: [] }, async () => ({
    bindings: [{ id: "api", workload: "main", producer: { service: "example-api", source: "connectivity" } }],
  })),
};
