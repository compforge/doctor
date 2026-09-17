import { expect, test } from "bun:test";

import {
  bindService,
  createServiceCatalog,
  isToolchain,
  type ServiceDefinition,
  type Toolchain,
} from "../src";

test("Service aliases resolve one canonical identity without inferring Workload names", () => {
  const service = { component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
    name: "runtime", aliases: ["rt", "engine"],
    workloads: [{ name: "worker", platform: "kubernetes", location: { kind: "service", name: "runtime-worker" } }],
    capabilities: { log: { default: true } },
  } satisfies ServiceDefinition;
  const catalog = createServiceCatalog([service]);
  expect(catalog.find("rt")).toBe(service);
  expect(catalog.findWith("engine", "log")).toBe(service);
  expect(catalog.resolveNames(["rt", "runtime", "engine"])).toEqual(["runtime"]);
  expect(catalog.servicesWith("log")).toEqual([service]);
  expect(catalog.find("worker")).toBeUndefined();
  expect(catalog.find("runtime-worker")).toBeUndefined();
  expect(catalog.find("RT")).toBeUndefined();
  expect(() => catalog.resolveNames(["missing"])).toThrow("Unknown Service");
});

test("Catalog rejects alias collisions regardless of declaration order", () => {
  const service = (name: string, aliases: string[]): ServiceDefinition => ({ component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } }, name, aliases, workloads: [], capabilities: {} });
  for (const entries of [
    [service("api", ["same"]), service("worker", ["same"])],
    [service("api", ["worker"]), service("worker", [])],
    [service("worker", []), service("api", ["worker"])],
    [service("api", ["api"])],
    [service("api", ["short", "short"])],
  ]) expect(() => createServiceCatalog(entries)).toThrow("conflicts");
  for (const alias of ["", " ", " a", "a b", "a,b"]) {
    expect(() => createServiceCatalog([service("api", [alias])])).toThrow("aliases");
  }
});

test("Service Catalog 保留 Plugin 声明的 Toolchain", () => {
  const toolchain: Toolchain = {
    language: "typescript",
    executionPlatform: "node",
    dependencyManager: "pnpm",
    buildTool: "tsc",
  };
  const catalog = createServiceCatalog([{ component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
    name: "api",
    workloads: [],
    toolchain,
    capabilities: {},
  }]);

  expect(catalog.find("api")?.toolchain).toBe(toolchain);
});

test("Service 不声明 Toolchain 仍可注册其它 capability", () => {
  const service: ServiceDefinition = { component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
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
  expect(() => createServiceCatalog([{ component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
    name: "api",
    workloads: [{
      name: "main",
      platform: "kubernetes", location: { kind: "service", name: "api-v1" },
    }, {
      name: "main",
      platform: "kubernetes", location: { kind: "service", name: "api-v2" },
    }],
    capabilities: {},
  }])).toThrow("重复 Workload 名称");
});

test("Service Catalog 统一查找 Inspect、Probe 与 Detector contribution", () => {
  const service: ServiceDefinition = { component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
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
        inspect: async (_context, queries) => queries.map(query => ({
          identity: query.identity, status: "collected" as const, result: {
            resolution: {
              inputId: query.identity.value,
              resolvedAs: query.identity.kind,
              identifiers: {},
            },
            facts: [],
          },
        })),
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

test("Catalog declaration binds directly to the common Service without mutating its environment", () => {
  const definition: ServiceDefinition = {
    name: "api", component: { name: "api", repository: { forge: { name: "github" }, path: "sample/api" } },
    workloads: [{ name: "main", platform: "kubernetes", location: { kind: "resource", resource_kind: "Deployment", name: "api-v2" } }],
    capabilities: {},
  };
  const first = bindService(definition, { name: "test", kind: "kubernetes" });
  const second = bindService(definition, { name: "prod", kind: "kubernetes" });
  const shared: import("@compforge/harness-common").Service = first;
  expect(shared.component).toBe(definition.component);
  expect(shared.workloads).toBe(definition.workloads);
  expect(first.environment.name).toBe("test");
  expect(second.environment.name).toBe("prod");
  expect(definition).not.toHaveProperty("environment");
});
