import { expect, test } from "bun:test";
import { validatePluginDefinition } from "../src/plugin/definition";
import type { PluginManifest } from "../src/plugin/manifest";

const manifest: PluginManifest = {
  manifestVersion: 1,
  pluginApiVersion: 1,
  id: "test",
  version: "0.0.1",
  requiresDoctor: ">=0.1.0",
  contentDigest: `sha256:${"0".repeat(64)}`,
  main: "./plugin.mjs",
  skills: [],
};

test("Plugin model capability requires an endpoint on each provider", () => {
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
      capabilities: {
        tenantDirectory: {
          endpoint: { port: 8080 },
          access: {},
          create: () => ({
            listActive: async () => [],
            getByName: async (name: string) => ({ id: name, name, displayName: name }),
          }),
        },
      },
    }, {
      name: "model-catalog",
      capabilities: {
        modelCatalog: {
          endpoint: { port: 8081 },
          access: {},
          create: () => ({
            listAvailable: async () => [],
            getBackend: async () => undefined,
          }),
        },
      },
    }, {
      name: "inference",
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

test("Plugin Toolchain 可省略，提供时必须满足公共协议", () => {
  const base = {
    id: "test",
    version: "0.0.1",
    services: { services: [{ name: "api", capabilities: {} }] },
  };
  expect(validatePluginDefinition(base, manifest).services.find("api")?.toolchain).toBeUndefined();

  expect(() => validatePluginDefinition({
    ...base,
    services: {
      services: [{
        name: "api",
        toolchain: { language: "python", executionPlatform: "unknown" },
        capabilities: {},
      }],
    },
  }, manifest)).toThrow("Plugin Service 'api'.toolchain is invalid");
});

test("Plugin trace source 必须引用 Catalog 中已声明的 Store", () => {
  const base = {
    id: "test",
    version: "0.0.1",
    trace: { analysis: {} },
    services: {
      services: [{
        name: "trace-store",
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

test("Plugin perf scenarios select Cases from the Service case capability", () => {
  const base = {
    id: "test",
    version: "0.0.1",
    services: { services: [{
      name: "chat",
      capabilities: {
        case: {
          endpoint: { port: 8000 },
          access: {},
          caseSets: [{
            id: "chat",
            title: "Chat Cases",
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
      capabilities: {
        ...base.services.services[0].capabilities,
        case: {
          ...caseCapability,
          caseSets: [{ ...caseSet, facets: undefined }],
        },
      },
    }] },
  }, manifest)).toThrow("references an undeclared facet");

  expect(() => validatePluginDefinition({
    ...base,
    services: { services: [{
      name: "chat",
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
  }, manifest)).toThrow("has unknown value 'medium'");

  expect(() => validatePluginDefinition({
    ...base,
    services: { services: [{
      name: "chat",
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
    capabilities: {
      case: {
        endpoint: { port: 8000 },
        access: {},
        caseSets: [{
          id: "chat",
          title: "Chat Cases",
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
      capabilities: {
        tenantDirectory: {
          endpoint: { port: 8001 },
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
