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
    toolchain,
    capabilities: {},
  }]);

  expect(catalog.find("api")?.toolchain).toBe(toolchain);
});

test("Service 不声明 Toolchain 仍可注册其它 capability", () => {
  const service: ServiceDefinition = {
    name: "legacy-api",
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
