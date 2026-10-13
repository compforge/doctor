import { createServiceCatalog, type PluginDefinition } from "@compforge/doctor-plugin";

/** 进程内测试（command-surface.test.ts）与 CLI 入口 fixture（plugin-cli.ts）共用的测试 Plugin。 */
export const testPlugin = {
  id: "test",
  version: "0.0.1",
  description: "Task processing product",
  concepts: "A Task owns Attempts.\nEach Attempt produces a Result.",
  workflows: "Submit → queue → execute → persist",
  services: createServiceCatalog([{
    component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
    name: "test-store",
    aliases: ["store"],
    concepts: "A Cache stores task results.",
    workflows: "Read cache → return result\nA cache miss is not a failed Task.",
    workloads: [],
    dataSources: [{
      id: "cache",
      kind: "redis",
      backend: "redis",
      environment: { address: "REDIS_ADDRESS" },
    }]
  }]),
} satisfies PluginDefinition;
