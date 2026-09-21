import { createServiceCatalog, type PluginDefinition } from "@compforge/doctor-plugin";

/** 进程内测试（command-surface.test.ts）与 CLI 入口 fixture（plugin-cli.ts）共用的测试 Plugin。 */
export const testPlugin = {
  id: "test",
  version: "0.0.1",
  services: createServiceCatalog([{
    component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
    name: "test-store",
    aliases: ["store"],
    workloads: [],
    dataSources: [{
      id: "cache",
      kind: "redis",
      backend: "redis",
      environment: { address: "REDIS_ADDRESS" },
    }]
  }]),
} satisfies PluginDefinition;
