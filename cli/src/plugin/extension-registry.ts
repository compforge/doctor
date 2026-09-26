import { ExtensionRegistry, extensionNamespace, type ExtensionRegistration, type PluginDefinition } from "@compforge/doctor-plugin";
import { modelCaseCatalogExtension } from "../collect/model/cases";
import { httpCaseCatalogExtension } from "../case/core-http";

/** The host composes providers once per discovery; kinds remain open to future Commands. */
export function createDoctorExtensionRegistry(
  plugin?: PluginDefinition,
  local: readonly ExtensionRegistration[] = [],
): ExtensionRegistry {
  const registry = new ExtensionRegistry();
  registry.register("core", [modelCaseCatalogExtension, httpCaseCatalogExtension]);
  registry.register("local", local);
  if (plugin) {
    registry.register(extensionNamespace("plugin", plugin.id), plugin.extensions ?? []);
    for (const service of plugin.services.services) {
      registry.register(extensionNamespace("plugin", plugin.id, "service", service.name), service.extensions ?? []);
    }
  }
  return registry;
}
