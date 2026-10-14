import { createServiceCatalog, type PluginDefinition } from "@compforge/doctor-plugin";

/** 进程内测试（command-surface.test.ts）与 CLI 入口 fixture（plugin-cli.ts）共用的测试 Plugin。 */
export const testPlugin = {
  id: "test",
  version: "0.0.1",
  description: "Task processing product",
  knowledge: {
    concepts: [{ id: "model", name: "Model", description: "A Task owns Attempts.\nEach Attempt produces a Result." }],
    workflows: [{ id: "flow", title: "Flow", summary: "Submit → queue → execute → persist", steps: [] }],
  },
  services: createServiceCatalog([{
    component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
    name: "test-store",
    aliases: ["store"],
    upstream: ["test-api"],
    knowledge: {
      concepts: [{ id: "model", name: "Model", description: "A Cache stores task results." }],
      workflows: [{ id: "flow", title: "Flow", summary: "Read cache → return result\nA cache miss is not a failed Task.", steps: [] }],
    },
    workloads: [],
    dataSources: [{
      id: "cache",
      kind: "redis",
      backend: "redis",
      environment: { address: "REDIS_ADDRESS" },
    }]
  }]),
} satisfies PluginDefinition;
