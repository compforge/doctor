import { createServiceCatalog, type PluginDefinition } from "@compforge/doctor-plugin";
import { startDoctor } from "../../src/app/main";

const plugin = {
  id: "test",
  services: createServiceCatalog([]),
} satisfies PluginDefinition;

startDoctor(plugin);
