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
