import { createServiceCatalog, type PluginDefinition } from "@compforge/doctor-plugin";
import { startDoctor } from "doctor-cli/embed";

const plugin = {
  id: "test",
  version: "0.0.1",
  services: createServiceCatalog([{ component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
    name: "test-store",
    aliases: ["store"],
    workloads: [],
    capabilities: {
      dataSources: [{
        id: "cache",
        kind: "redis",
        backend: "redis",
        environment: { address: "REDIS_ADDRESS" },
      }],
    },
  }]),
} satisfies PluginDefinition;

startDoctor({ plugin, commands: process.env.TEST_VISIBLE_COMMANDS });
