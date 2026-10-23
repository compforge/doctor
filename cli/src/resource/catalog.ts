import type { PluginDefinition, ServiceDefinition, ServiceResourceDefinition } from "@compforge/doctor-plugin";
import { CommandInputError } from "../command";

export interface ResourceProvider { service: ServiceDefinition; binding: ServiceResourceDefinition }
export interface ResourceSelection { services?: readonly string[]; resource?: string; kind?: string }

/** Select associations, not unique collections: provider scopes may differ and must never be added together. */
export function resourceProviders(plugin: PluginDefinition, selection: ResourceSelection): ResourceProvider[] {
  const services = selection.services === undefined ? undefined : new Set(plugin.services.resolveNames(selection.services));
  const selected = plugin.services.resourceSources().filter(({ service, binding }) =>
    (!services || services.has(service.name)) && (!selection.resource || binding.resource.id === selection.resource)
      && (!selection.kind || binding.resource.kind === selection.kind));
  if (selection.resource && !selected.length) throw new CommandInputError(`未找到 Resource '${selection.resource}'`);
  return selected;
}
