import { ExtensionRegistry, type ExtensionRegistration, type PluginDefinition } from "@compforge/doctor-plugin";
import { modelCaseCatalogExtension } from "../collect/model/cases";
import { httpCaseCatalogExtension } from "../case/core-http";

/** The host composes providers once per discovery; kinds remain open to future Commands. */
export function createDoctorExtensionRegistry(
  plugin?: PluginDefinition,
  local: readonly ExtensionRegistration[] = [],
  adapters: readonly { owner: string; extension: ExtensionRegistration }[] = [],
): ExtensionRegistry {
  const registry = new ExtensionRegistry();
  registry.register("core", [modelCaseCatalogExtension, httpCaseCatalogExtension]);
  registry.register("local", local);
  if (plugin) {
    registry.register(`plugin:${plugin.id}`, plugin.extensions ?? []);
    for (const service of plugin.services.services) {
      registry.register(`service:${service.name}`, service.extensions ?? []);
    }
  }
  for (const { owner, extension } of adapters) registry.register(owner, [extension]);
  return registry;
}
