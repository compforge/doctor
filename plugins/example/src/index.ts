import {
  createServiceCatalog,
  type PluginDefinition,
} from "@compforge/doctor-plugin";
import pluginPackage from "../package.json" with { type: "json" };

const services = createServiceCatalog([
  {
    name: "example-api",
    toolchain: {
      language: "typescript",
      executionPlatform: "node",
      dependencyManager: "npm",
      buildTool: "tsc",
    },
    capabilities: {
      config: {},
      log: { default: true },
    },
  },
  {
    name: "example-worker",
    toolchain: {
      language: "python",
      executionPlatform: "python",
      dependencyManager: "uv",
    },
    capabilities: {
      log: { default: false },
      stores: [{
        id: "primary-database",
        kind: "db",
        backend: "mysql",
        envPrefix: "DATABASE_",
      }],
    },
  },
] as const);

export const examplePlugin = {
  id: "example",
  version: pluginPackage.version,
  services,
} satisfies PluginDefinition;

export default examplePlugin;
