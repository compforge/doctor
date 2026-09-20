import { inspectExtension, traceExtension } from "./extension-fixture";
import { expect, test } from "bun:test";
import { describeService, requireFactsInspectExtension, type ServiceDefinition } from "../src";

function noAccess(): never { throw new Error("offline discovery must not execute a handler"); }

const service: ServiceDefinition = {
  component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
  name: "runtime",
  description: "Session and run evidence",
  workloads: [{
    name: "worker", description: "Handles session runs", container: "app",
    platform: "kubernetes", location: { kind: "labels", labels: { app: "worker" } },
  }],
  dependencies: [{ id: "records", service: "storage", dataSource: "main" }],
  logs: { default: false },
  dataSources: [{ id: "database", kind: "db", backend: "mysql", envPrefix: "PRIVATE_DB" }],
  detectors: [{ id: "state", detect: noAccess }],
  extensions: [traceExtension({ access: {}, endpoint: { host: "private-host", port: 80 }, resolve: noAccess }),
  inspectExtension({
    description: "Find persisted sessions and runs",
    limitations: ["Only retained records can be returned"],
    accepts: ["conversation_id"], provides: ["runtime-record"], expands: ["run_id"], dataSource: "database",
    access: {
      kubernetes: [{
        rule: { verb: "get", resource: "configmaps", resourceName: "runtime", allNamespaces: true },
        requirement: "required", purpose: "Locate storage",
      }]
    },
    resolveTarget: noAccess, inspect: noAccess,
  })]
};

test("description projects the execution declaration without confusing inputs and relations", () => {
  const result = describeService(service);
  expect(result.name).toBe("runtime");
  expect(result.description).toBe("Session and run evidence");
  expect(result.extensions?.map(item => item.kind)).toEqual(["trace.resolve", "facts.inspect"]);
  expect(result.detectors).toEqual(["state"]);
  expect(result.details.inspect).toEqual({
    description: "Find persisted sessions and runs", limitations: ["Only retained records can be returned"],
    accepts: ["conversation_id"], provides: ["runtime-record"], expands: ["run_id"], dataSource: "database",
  });
  expect(result.details.inspect?.accepts).not.toContain("run_id");
  expect(service.workloads).toEqual(result.details.workloads);
  expect(service.dependencies!).toEqual(result.details.dependencies);
  expect(result.details.dataSources).toEqual([{ id: "database", kind: "db", backend: "mysql", description: undefined }]);
  expect(result.details.access).toEqual([
    { owner: "extensions.trace.resolve", requirements: { kubernetes: [] } },
    { owner: "extensions.inspect", requirements: requireFactsInspectExtension(service.extensions![1]!).access },
  ]);
});

test("explicit projection excludes credentials, configuration and functions even from untyped extensions", () => {
  const secret = "must-not-be-exposed";
  const source = {
    ...service,
    config: { password: secret },
    workloads: service.workloads.map(workload => ({
      ...workload, password: secret,
      location: { ...workload.location, password: secret }
    })),
    dependencies: service.dependencies!.map(dependency => ({ ...dependency, password: secret })),
    extensions: [inspectExtension({
      ...requireFactsInspectExtension(service.extensions![1]!), inspect: noAccess,
      access: {
        kubernetes: [{
          ...requireFactsInspectExtension(service.extensions![1]!).access.kubernetes![0]!,
          rule: Object.assign({ verb: "get", resource: "configmaps" }, { password: secret }),
        }]
      },
    })]
  };
  const json = JSON.stringify(describeService(source));
  for (const excluded of [secret, "private-host", "PRIVATE_DB", "resolveTarget", "endpoint", "password"]) {
    expect(json).not.toContain(excluded);
  }
});

test("old Services and empty declarations stay discoverable without invented capabilities", () => {
  const result = describeService({
    component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
    name: "legacy",
    workloads: []
  });
  expect(result).toEqual({
    name: "legacy", aliases: [], description: undefined, detectors: [], environmentProbes: [],
    details: { workloads: [], dependencies: [], dataSources: [], inspect: undefined, access: [] }
  });
  const withoutExplanation = { ...requireFactsInspectExtension(service.extensions![1]!), description: undefined, limitations: undefined };
  expect(describeService({
    ...service,
    extensions: [{ ...withoutExplanation }]
  }).details.inspect)
    .toMatchObject({ description: undefined, limitations: [] });
});

test("VDB Store access is projected per Store without resolving targets or exposing configuration", () => {
  const result = describeService({
    component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
    name: "storage",
    workloads: [],
    dataSources: [
      {
        id: "primary", kind: "vdb", backend: "opensearch",
        access: {
          kubernetes: [{
            rule: { verb: "get", resource: "configmaps" },
            requirement: "required", purpose: "Locate primary storage"
          }]
        },
        configuration: { file: { pathEnvironment: "PRIVATE_CONFIG", defaultPath: "/private/config" }, resolve: noAccess },
      },
      {
        id: "archive", kind: "vdb", backend: "opensearch",
        access: {
          kubernetes: [{
            rule: { verb: "create", resource: "pods/portforward" },
            requirement: "preferred", purpose: "Reach archive", fallback: "Direct connection"
          }]
        },
      },
      { id: "empty", kind: "vdb", backend: "opensearch", access: {} },
      { id: "legacy", kind: "vdb", backend: "opensearch" },
      { id: "database", kind: "db", backend: "mysql", envPrefix: "PRIVATE_DB" },
    ]
  });
  expect(result.details.access).toEqual([
    {
      owner: "dataSources.primary", requirements: {
        kubernetes: [{
          rule: { verb: "get", resource: "configmaps" }, requirement: "required", purpose: "Locate primary storage",
        }]
      }
    },
    {
      owner: "dataSources.archive", requirements: {
        kubernetes: [{
          rule: { verb: "create", resource: "pods/portforward" }, requirement: "preferred",
          purpose: "Reach archive", fallback: "Direct connection",
        }]
      }
    },
    { owner: "dataSources.empty", requirements: { kubernetes: [] } },
  ]);
  for (const excluded of ["PRIVATE_CONFIG", "/private/config", "PRIVATE_DB", "inspectTarget", "configuration"]) {
    expect(JSON.stringify(result)).not.toContain(excluded);
  }
});

test("description follows declaration changes and projects Kubernetes Service workloads", () => {
  const result = describeService({
    ...service,
    workloads: [{ name: "api", platform: "kubernetes", location: { kind: "service", name: "api-svc" } }],
    extensions: [Object.assign({}, requireFactsInspectExtension(service.extensions![1]!), { accepts: ["tenant_id"], provides: ["tenant-record"] })]
  });
  expect(result.details.inspect?.accepts).toEqual(["tenant_id"]);
  expect(result.details.inspect?.provides).toEqual(["tenant-record"]);
  expect(result.details.workloads[0]?.location).toEqual({ kind: "service", name: "api-svc" });
});
