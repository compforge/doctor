import { createServiceCatalog, type PluginDefinition } from "@compforge/doctor-plugin";
import { startDoctor } from "doctor-cli/embed";

const plugin = {
  id: "test",
  services: createServiceCatalog([{
    name: "test-store",
    capabilities: {
      stores: [{
        id: "cache",
        kind: "redis",
        backend: "redis",
        environment: { address: "REDIS_ADDRESS" },
      }],
    },
  }]),
} satisfies PluginDefinition;

startDoctor(plugin);
