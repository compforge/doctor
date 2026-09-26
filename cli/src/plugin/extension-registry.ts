import {
  ExtensionRegistry, extensionNamespace, type ExtensionRegistration, type PluginDefinition,
  type RegisteredProvider, type ServiceDefinition,
} from "@compforge/doctor-plugin";
import { modelCaseCatalogExtension } from "../collect/model/cases";
import { httpCaseCatalogExtension } from "../case/core-http";

export interface DoctorExtensionProvider extends RegisteredProvider {
  readonly origin: "core" | "plugin" | "local";
  /** The providing Service owns execution context regardless of the declared namespace. */
  readonly service?: ServiceDefinition;
}

/** The host retains provider bindings; namespaces determine discovery, not execution ownership. */
export function createDoctorExtensionRegistry(
  plugin?: PluginDefinition,
  local: readonly ExtensionRegistration[] = [],
): { extensions(kind: string, namespace?: string): DoctorExtensionProvider[] } {
  const registry = new ExtensionRegistry();
  const bindings = new Map<RegisteredProvider, Pick<DoctorExtensionProvider, "origin" | "service">>();
  const register = (namespace: string, extensions: readonly ExtensionRegistration[],
    origin: DoctorExtensionProvider["origin"], service?: ServiceDefinition) => {
    for (const provider of registry.register(namespace, extensions)) {
      bindings.set(provider, service ? { origin, service } : { origin });
    }
  };
  register("core", [modelCaseCatalogExtension, httpCaseCatalogExtension], "core");
  register("local", local, "local");
  if (plugin) {
    register(extensionNamespace("plugin", plugin.id), plugin.extensions ?? [], "plugin");
    for (const service of plugin.services.services) {
      register(extensionNamespace("plugin", plugin.id, "service", service.name), service.extensions ?? [], "plugin", service);
    }
  }
  return { extensions: (kind, namespace) => registry.extensions(kind, namespace)
    .map(provider => ({ ...provider, ...bindings.get(provider)! })) };

}
