import { expect, test } from "bun:test";
import { describeService, type ServiceDefinition } from "../src";

function noAccess(): never { throw new Error("offline discovery must not execute a handler"); }

const service: ServiceDefinition = {
  name: "runtime",
  description: "Session and run evidence",
  workloads: [{
    name: "worker", lifecycle: "ephemeral", container: "app",
    discovery: { kind: "kubernetes-pods", labels: { app: "worker" } },
  }],
  dependencies: [{ id: "records", service: "storage", capability: "stores", store: "main" }],
  capabilities: {
    log: { default: false },
    traceId: { access: {}, endpoint: { host: "private-host", port: 80 }, resolve: noAccess },
    stores: [{ id: "database", kind: "db", backend: "mysql", envPrefix: "PRIVATE_DB" }],
    metric: undefined,
  },
  contributions: {
    inspect: {
      description: "Find persisted sessions and runs",
      limitations: ["Only retained records can be returned"],
      accepts: ["conversation_id"], provides: ["runtime-record"], expands: ["run_id"], store: "database",
      access: { kubernetes: [{
        rule: { verb: "get", resource: "configmaps", resourceName: "runtime", allNamespaces: true },
        requirement: "required", purpose: "Locate storage",
      }] },
      resolveTarget: noAccess, inspect: noAccess,
    },
    detectors: [{ id: "state", detect: noAccess }],
  },
};

test("description projects the execution declaration without confusing inputs and relations", () => {
  const result = describeService(service);
  expect(result.name).toBe("runtime");
  expect(result.description).toBe("Session and run evidence");
  expect(result.capabilities).toEqual(["log", "traceId", "stores"]);
  expect(result.contributions).toEqual(["inspect", "detectors"]);
  expect(result.details.inspect).toEqual({
    description: "Find persisted sessions and runs", limitations: ["Only retained records can be returned"],
    accepts: ["conversation_id"], provides: ["runtime-record"], expands: ["run_id"], store: "database",
  });
  expect(result.details.inspect?.accepts).not.toContain("run_id");
  expect(service.workloads).toEqual(result.details.workloads);
  expect(service.dependencies!).toEqual(result.details.dependencies);
  expect(result.details.stores).toEqual([{ id: "database", kind: "db" }]);
  expect(result.details.access).toEqual([
    { owner: "contributions.inspect", requirements: service.contributions!.inspect!.access },
    { owner: "capabilities.traceId", requirements: { kubernetes: [] } },
  ]);
});

test("explicit projection excludes credentials, configuration and functions even from untyped extensions", () => {
  const secret = "must-not-be-exposed";
  const source = {
    ...service, config: { password: secret },
    workloads: service.workloads.map(workload => ({ ...workload, password: secret,
      discovery: { ...workload.discovery, password: secret } })),
    dependencies: service.dependencies!.map(dependency => ({ ...dependency, password: secret })),
    contributions: { inspect: {
      ...service.contributions!.inspect!, password: secret,
      access: { password: secret, kubernetes: [{
        ...service.contributions!.inspect!.access.kubernetes![0]!, password: secret,
        rule: { verb: "get", resource: "configmaps", password: secret },
      }] },
    } },
  };
  const json = JSON.stringify(describeService(source));
  for (const excluded of [secret, "private-host", "PRIVATE_DB", "resolveTarget", "endpoint", "password"]) {
    expect(json).not.toContain(excluded);
  }
});

test("old Services and empty declarations stay discoverable without invented capabilities", () => {
  const result = describeService({ name: "legacy", workloads: [], capabilities: {} });
  expect(result).toEqual({ name: "legacy", description: undefined, capabilities: [], contributions: [],
    details: { workloads: [], dependencies: [], stores: [], inspect: undefined, access: [] } });
  const withoutExplanation = { ...service.contributions!.inspect!, description: undefined, limitations: undefined };
  expect(describeService({ ...service, contributions: { inspect: withoutExplanation } }).details.inspect)
    .toMatchObject({ description: undefined, limitations: [] });
});

test("description follows declaration changes and projects Kubernetes Service workloads", () => {
  const result = describeService({ ...service,
    workloads: [{ name: "api", lifecycle: "persistent", discovery: { kind: "kubernetes-service", service: "api-svc" } }],
    contributions: { inspect: { ...service.contributions!.inspect!, accepts: ["tenant_id"], provides: ["tenant-record"] } },
  });
  expect(result.details.inspect?.accepts).toEqual(["tenant_id"]);
  expect(result.details.inspect?.provides).toEqual(["tenant-record"]);
  expect(result.details.workloads[0]?.discovery).toEqual({ kind: "kubernetes-service", service: "api-svc" });
});
