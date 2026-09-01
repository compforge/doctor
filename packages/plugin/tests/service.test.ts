import { expect, test } from "bun:test";

import {
  createServiceCatalog,
  isToolchain,
  type ServiceDefinition,
  type Toolchain,
} from "../src";

test("Service Catalog 保留 Plugin 声明的 Toolchain", () => {
  const toolchain: Toolchain = {
    language: "typescript",
    executionPlatform: "node",
    dependencyManager: "pnpm",
    buildTool: "tsc",
  };
  const catalog = createServiceCatalog([{
    name: "api",
    workloads: [],
    toolchain,
    capabilities: {},
  }]);

  expect(catalog.find("api")?.toolchain).toBe(toolchain);
});

test("Service 不声明 Toolchain 仍可注册其它 capability", () => {
  const service: ServiceDefinition = {
    name: "legacy-api",
    workloads: [],
    capabilities: { log: { default: true } },
  };
  const catalog = createServiceCatalog([service]);

  expect(catalog.find("legacy-api")?.toolchain).toBeUndefined();
  expect(catalog.findWith("legacy-api", "log")?.capabilities.log.default).toBe(true);
});

test("Toolchain runtime validator 只校验已提供的声明", () => {
  expect(isToolchain(undefined)).toBe(false);
  expect(isToolchain({ language: "python", executionPlatform: "python" })).toBe(true);
  expect(isToolchain({ language: "python", executionPlatform: "unknown" })).toBe(false);
});

test("Service Catalog 拒绝同一 Service 内重复 Workload 身份", () => {
  expect(() => createServiceCatalog([{
    name: "api",
    workloads: [{
      name: "main",
      lifecycle: "persistent",
      discovery: { kind: "kubernetes-service", service: "api-v1" },
    }, {
      name: "main",
      lifecycle: "persistent",
      discovery: { kind: "kubernetes-service", service: "api-v2" },
    }],
    capabilities: {},
  }])).toThrow("重复 Workload 名称");
});

test("Service Catalog 统一查找 Inspect、Probe 与 Detector contribution", () => {
  const service: ServiceDefinition = {
    name: "api",
    workloads: [],
    contributions: {
      inspect: {
        access: {},
        accepts: ["biz_id"],
        provides: ["record"],
        resolveTarget: async () => ({
          endpoint: "http://api",
          database: "api",
          username: "reader",
          credentialSource: "test",
        }),
        inspect: async (_context, query) => ({
          resolution: {
            inputId: query.identity.value,
            resolvedAs: query.identity.kind,
            identifiers: {},
          },
          facts: [],
        }),
      },
      probes: [{
        id: "apparmor",
        kind: "kubernetes.apparmor-unconfined-admission",
        schemaVersion: 1,
        subject: "workload-service-account",
      }],
      detectors: [{ id: "health", detect: () => [] }],
    },
    capabilities: {},
  };
  const catalog = createServiceCatalog([service]);

  expect(catalog.findWithContribution("api", "inspect")?.contributions.inspect.provides)
    .toEqual(["record"]);
  expect(catalog.findWithContribution("api", "probes")?.contributions.probes[0]?.id)
    .toBe("apparmor");
  expect(catalog.servicesWithContribution("detectors").map(({ name }) => name))
    .toEqual(["api"]);
});
