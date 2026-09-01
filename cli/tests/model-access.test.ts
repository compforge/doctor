import { expect, test } from "bun:test";
import { validatePluginDefinition } from "../src/plugin/definition";
import { DOCTOR_PLUGIN_API_VERSION } from "@compforge/doctor-plugin";
import type { PluginManifest } from "../src/plugin/manifest";
import { openModelAccess } from "../src/model";

const manifest: PluginManifest = {
  manifestVersion: 1,
  pluginApiVersion: DOCTOR_PLUGIN_API_VERSION,
  id: "test",
  version: "0.0.1",
  requiresDoctor: ">=0.1.0",
  contentDigest: `sha256:${"0".repeat(64)}`,
  main: "./plugin.mjs",
  skills: [],
};

test("Plugin Inspect contribution 必须提供 inspect", () => {
  const base = {
    access: {},
    accepts: ["biz_id"],
    provides: ["record"],
    resolveTarget: async () => ({}),
  };
  const definition = (inspect: Record<string, unknown>) => ({
    id: "test",
    version: "0.0.1",
    services: { services: [{ name: "records", workloads: [], contributions: { inspect }, capabilities: {} }] },
  });

  expect(validatePluginDefinition(definition({ ...base, inspect: async () => ({}) }), manifest))
    .toBeDefined();
  expect(() => validatePluginDefinition(definition({ ...base, query: async () => ({}) }), manifest))
    .toThrow("records.contributions.inspect.inspect must be a function");
  expect(() => validatePluginDefinition(definition(base), manifest))
    .toThrow("records.contributions.inspect.inspect must be a function");
});

test("Plugin tenant capability 只绑定租户目录", () => {
  const valid = {
    id: "test",
    version: "0.0.1",
    tenant: { directoryService: "iam" },
    services: { services: [{
      name: "iam",
      workloads: [],
      capabilities: {
        tenantDirectory: {
          endpoint: { host: "test-service", port: 8080 },
          access: {},
          create: () => ({
            listActive: async () => [],
            getByName: async (name: string) => ({ id: name, name, displayName: name }),
          }),
        },
      },
    }] },
  };
  expect(validatePluginDefinition(valid, manifest).tenant).toEqual({ directoryService: "iam" });
  expect(() => validatePluginDefinition({
    ...valid,
    services: { services: [] },
  }, manifest)).toThrow("unknown Service 'iam'");
});

test("Plugin model capability requires an endpoint on each declared provider", () => {
  const plugin = {
    id: "test",
    version: "0.0.1",
    model: {
      tenantDirectoryService: "tenant-directory",
      catalogService: "model-catalog",
      inferenceService: "inference",
    },
    services: { services: [{
      name: "tenant-directory",
      workloads: [],
      capabilities: {
        tenantDirectory: {
          endpoint: { host: "test-service", port: 8080 },
          access: {},
          create: () => ({
            listActive: async () => [],
            getByName: async (name: string) => ({ id: name, name, displayName: name }),
          }),
        },
      },
    }, {
      name: "model-catalog",
      workloads: [],
      capabilities: {
        modelCatalog: {
          endpoint: { host: "test-service", port: 8081 },
          access: {},
          create: () => ({
            query: async () => [],
            getBackend: async () => undefined,
          }),
        },
      },
    }, {
      name: "inference",
      workloads: [],
      capabilities: {
        inference: {
          access: {},
          create: async () => {
            throw new Error("inference factory must not run");
          },
        },
      },
    }] },
  };

  expect(() => validatePluginDefinition(plugin, manifest)).toThrow(
    "inference.endpoint must be an object",
  );
});

test("Plugin model capability supports discovery without inference", async () => {
  const plugin = {
    id: "test",
    version: "0.0.1",
    model: {
      tenantDirectoryService: "tenant-directory",
      catalogService: "model-catalog",
    },
    services: { services: [{
      name: "tenant-directory",
      workloads: [],
      capabilities: {
        tenantDirectory: {
          endpoint: { host: "test-service", port: 8080 },
          access: {},
          create: () => ({
            listActive: async () => [],
            getByName: async (name: string) => ({ id: name, name, displayName: name }),
          }),
        },
      },
    }, {
      name: "model-catalog",
      workloads: [],
      capabilities: {
        modelCatalog: {
          endpoint: { host: "test-service", port: 8081 },
          access: {},
          create: () => ({
            query: async () => [],
            getBackend: async () => undefined,
          }),
        },
      },
    }] },
  };

  const validated = validatePluginDefinition(plugin, manifest);
  expect(validated.model).toEqual({
    tenantDirectoryService: "tenant-directory",
    catalogService: "model-catalog",
  });
  await expect(openModelAccess({ command: "doctor model", plugin: validated })).rejects.toThrow(
    "model capability 未声明 inferenceService",
  );
});

test("Plugin Toolchain 可省略，提供时必须满足公共协议", () => {
  const base = {
    id: "test",
    version: "0.0.1",
    services: { services: [{ name: "api", workloads: [], capabilities: {} }] },
  };
  expect(validatePluginDefinition(base, manifest).services.find("api")?.toolchain).toBeUndefined();

  expect(() => validatePluginDefinition({
    ...base,
    services: {
      services: [{
        name: "api",
        workloads: [],
        toolchain: { language: "python", executionPlatform: "unknown" },
        capabilities: {},
      }],
    },
  }, manifest)).toThrow("Plugin Service 'api'.toolchain is invalid");
});

test("Service probes 只接受 Core 支持的声明式共同 Probe", () => {
  const probe = {
    id: "apparmor-unconfined",
    kind: "kubernetes.apparmor-unconfined-admission",
    schemaVersion: 1,
    subject: "workload-service-account",
  } as const;
  const plugin = (candidate: Record<string, unknown>) => ({
    id: "test",
    version: "0.0.1",
    services: { services: [{
      name: "runtime-api",
      workloads: [],
      contributions: { probes: [candidate] },
      capabilities: {},
    }] },
  });

  expect(validatePluginDefinition(plugin(probe), manifest).services
    .findWithContribution("runtime-api", "probes")?.contributions.probes)
    .toEqual([probe]);
  expect(() => validatePluginDefinition(plugin({ ...probe, kind: "custom.exec" }), manifest))
    .toThrow("uses unsupported kind 'custom.exec'");
  expect(() => validatePluginDefinition(plugin({ ...probe, subject: "fixed-service-account" }), manifest))
    .toThrow("uses unsupported subject 'fixed-service-account'");
  expect(() => validatePluginDefinition(plugin({ ...probe, schemaVersion: 2 }), manifest))
    .toThrow("uses unsupported schemaVersion '2'");
});

test("Service detector 必须有唯一 id 与纯 detect 入口", () => {
  const definition = (detectors: unknown) => ({
    id: "test",
    version: "0.0.1",
    services: { services: [{
      name: "runtime-api",
      workloads: [],
      contributions: { detectors },
      capabilities: {},
    }] },
  });
  const detector = { id: "runtime-health", detect: () => [] };

  expect(validatePluginDefinition(definition([detector]), manifest).services
    .find("runtime-api")?.contributions?.detectors?.[0]?.id).toBe("runtime-health");
  expect(() => validatePluginDefinition(definition([
    detector,
    { ...detector },
  ]), manifest)).toThrow("runtime-api.contributions.detectors contains duplicate id 'runtime-health'");
  expect(() => validatePluginDefinition(definition([{
    id: "runtime-health",
  }]), manifest)).toThrow("runtime-api.contributions.detectors.runtime-health.detect must be a function");
});

test("Workload Probe 在执行前声明 Observation kind 与 schemaVersion", () => {
  const definition = (observation: unknown) => ({
    id: "test",
    version: "0.0.1",
    services: { services: [{
      name: "runtime-api",
      workloads: [{
        name: "main",
        lifecycle: "persistent",
        discovery: { kind: "kubernetes-service", service: "runtime-api" },
      }],
      contributions: { probes: [{
        id: "health",
        kind: "workload",
        schemaVersion: 1,
        access: {},
        workload: "main",
        observation,
        probe: async () => ({ value: {} }),
      }] },
      capabilities: {},
    }] },
  });

  const validated = validatePluginDefinition(definition({
    kind: "health",
    schemaVersion: 1,
  }), manifest).services.find("runtime-api")?.contributions?.probes?.[0];
  expect(validated?.kind).toBe("workload");
  expect(validated?.kind === "workload" ? validated.observation : undefined)
    .toEqual({ kind: "health", schemaVersion: 1 });
  expect(() => validatePluginDefinition(definition({ schemaVersion: 1 }), manifest))
    .toThrow("runtime-api.contributions.probes.health.observation.kind must be a non-empty string");
  expect(() => validatePluginDefinition(definition({ kind: "health", schemaVersion: 0 }), manifest))
    .toThrow("runtime-api.contributions.probes.health.observation.schemaVersion must be a positive integer");
});

test("Plugin trace source 必须引用 Catalog 中已声明的 Store", () => {
  const base = {
    id: "test",
    version: "0.0.1",
    trace: { analysis: {} },
    services: {
      services: [{
        name: "trace-store",
        workloads: [],
        capabilities: {
          stores: [{ id: "vdb", kind: "vdb", backend: "opensearch" }],
        },
      }],
    },
  };

  expect(validatePluginDefinition({
    ...base,
    trace: {
      ...base.trace,
      source: { store: { service: "trace-store", store: "vdb" } },
    },
  }, manifest).trace?.source?.store).toEqual({ service: "trace-store", store: "vdb" });

  expect(() => validatePluginDefinition({
    ...base,
    trace: {
      ...base.trace,
      source: { store: { service: "missing", store: "vdb" } },
    },
  }, manifest)).toThrow("trace.source.store references unknown Service 'missing'");

  expect(() => validatePluginDefinition({
    ...base,
    trace: {
      ...base.trace,
      source: { store: { service: "trace-store", store: "missing" } },
    },
  }, manifest)).toThrow("trace.source.store references unknown Store 'trace-store/missing'");
});

test("Service capability dependency 必须引用另一 Service 已声明的 Store", () => {
  const dependency = {
    id: "trace-store",
    service: "kb-server",
    capability: "stores",
    store: "vdb",
  } as const;
  const base = {
    id: "test",
    version: "0.0.1",
    services: {
      services: [{
        name: "kb-server",
        workloads: [],
        capabilities: {
          stores: [{ id: "vdb", kind: "vdb", backend: "opensearch" }],
        },
      }, {
        name: "opensearch",
        workloads: [],
        dependencies: [dependency],
        capabilities: {},
      }],
    },
  };

  expect(validatePluginDefinition(base, manifest).services.find("opensearch")?.dependencies)
    .toEqual([dependency]);

  expect(() => validatePluginDefinition({
    ...base,
    services: {
      services: [base.services.services[0], {
        ...base.services.services[1],
        dependencies: [{
          id: "trace-store",
          service: "kb-server",
          capability: "stores",
          store: "missing",
        }],
      }],
    },
  }, manifest)).toThrow("references unknown Store 'kb-server/missing'");

  expect(() => validatePluginDefinition({
    ...base,
    services: {
      services: [base.services.services[0], {
        ...base.services.services[1],
        dependencies: [
          dependency,
          dependency,
        ],
      }],
    },
  }, manifest)).toThrow("contains duplicate id 'trace-store'");

  expect(() => validatePluginDefinition({
    ...base,
    services: {
      services: [{
        name: "kb-server",
        workloads: [],
        capabilities: {
          stores: [{ id: "database", kind: "db", backend: "mysql", envPrefix: "DB" }],
        },
      }, {
        ...base.services.services[1],
        dependencies: [{ ...dependency, store: "database" }],
      }],
    },
  }, manifest)).toThrow("当前只支持 OpenSearch VDB");
});

test("Plugin perf scenarios select Cases from the Service case capability", () => {
  const base = {
    id: "test",
    version: "0.0.1",
    services: { services: [{
      name: "chat",
      workloads: [],
      capabilities: {
        case: {
          endpoint: { host: "test-service", port: 8000 },
          access: {},
          caseSets: [{
            caseset: "chat",
            focus: "Chat Cases",
            schema_version: 1,
            facets: {
              difficulty: { values: ["simple", "complex"], ordered: true },
            },
            cases: [{
              id: "ordinary_chat",
              input: { query: "hello" },
              facets: { difficulty: "simple" },
            }],
          }],
          createRunner: async () => { throw new Error("factory must not run"); },
        },
        perf: {
          scenarios: [{
            id: "ordinary-chat",
            title: "普通 Chat",
            description: "SSE Chat",
            caseSetId: "chat",
            cases: [{ caseId: "ordinary_chat", weight: 1 }],
            observability: {
              metricServices: ["chat"],
              logServices: ["chat"],
              correlationKeys: ["message_id"],
            },
          }],
        },
      },
    }] },
  };
  expect(validatePluginDefinition(base, manifest).services.find("chat")?.capabilities.perf)
    .toBeDefined();

  const caseCapability = base.services.services[0].capabilities.case;
  const caseSet = caseCapability.caseSets[0];
  expect(() => validatePluginDefinition({
    ...base,
    services: { services: [{
      name: "chat",
      workloads: [],
      capabilities: {
        ...base.services.services[0].capabilities,
        case: {
          ...caseCapability,
          caseSets: [{ ...caseSet, facets: undefined }],
        },
      },
    }] },
  }, manifest)).toThrow("unknown facet 'difficulty'");

  expect(() => validatePluginDefinition({
    ...base,
    services: { services: [{
      name: "chat",
      workloads: [],
      capabilities: {
        ...base.services.services[0].capabilities,
        case: {
          ...caseCapability,
          caseSets: [{
            ...caseSet,
            cases: [{
              ...caseSet.cases[0],
              facets: { difficulty: "medium" },
            }],
          }],
        },
      },
    }] },
  }, manifest)).toThrow("facet difficulty='medium' not in declared values");

  expect(() => validatePluginDefinition({
    ...base,
    services: { services: [{
      name: "chat",
      workloads: [],
      capabilities: {
        case: base.services.services[0].capabilities.case,
        perf: { ...base.services.services[0].capabilities.perf, scenarios: [] },
      },
    }] },
  }, manifest)).toThrow("chat.perf.scenarios must be a non-empty array");

  expect(() => validatePluginDefinition({
    ...base,
    services: { services: [{
      name: "chat",
      workloads: [],
      capabilities: {
        ...base.services.services[0].capabilities,
        perf: {
          scenarios: [{
            ...base.services.services[0].capabilities.perf.scenarios[0],
            cases: [{ caseId: "missing" }],
          }],
        },
      },
    }] },
  }, manifest)).toThrow("references unknown Case 'missing'");
});

test("Plugin Case request identity references a tenant directory provider", () => {
  const caseService = {
    name: "chat",
    workloads: [],
    capabilities: {
      case: {
        endpoint: { host: "test-service", port: 8000 },
        access: {},
        caseSets: [{
          caseset: "chat",
          focus: "Chat Cases",
          schema_version: 1,
          cases: [{ id: "ordinary_chat", input: { query: "hello" } }],
        }],
        requestIdentity: {
          directoryService: "iam",
          configured: () => ({}),
        },
        createRunner: async () => { throw new Error("factory must not run"); },
      },
    },
  };
  expect(() => validatePluginDefinition({
    id: "test",
    version: "0.0.1",
    services: { services: [caseService] },
  }, manifest)).toThrow("references unknown Service 'iam'");

  expect(validatePluginDefinition({
    id: "test",
    version: "0.0.1",
    services: { services: [caseService, {
      name: "iam",
      workloads: [],
      capabilities: {
        tenantDirectory: {
          endpoint: { host: "test-service", port: 8001 },
          access: {},
          create: () => ({
            listActive: async () => [],
            getByName: async (name: string) => ({ id: name, name, displayName: name }),
          }),
        },
      },
    }] },
  }, manifest).services.find("chat")?.capabilities.case?.requestIdentity?.directoryService).toBe("iam");
});
