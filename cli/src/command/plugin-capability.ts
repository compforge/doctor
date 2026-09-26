import type { PluginDefinition } from "@compforge/doctor-plugin";

export type PluginCapabilityRequirement = "required" | "preferred";

export type PluginCapabilityReference =
  | { scope: "resource"; name: "dataSources" | "logs" }
  | { scope: "extension"; name: string };

export interface PluginCapabilityNeed {
  capability: PluginCapabilityReference;
  requirement: PluginCapabilityRequirement;
  purpose: string;
  fallback?: string;
}

/** Command 依赖 Doctor Host 已加载的 Plugin，并声明自身需要的业务语义。 */
export interface PluginCapabilityContract {
  command: string;
  needs: readonly PluginCapabilityNeed[];
}

export interface PluginCapabilityFact {
  need: PluginCapabilityNeed;
  available: boolean;
  providers: readonly string[];
}

export interface PluginCapabilityEvaluation {
  plugin?: PluginDefinition;
  contract: PluginCapabilityContract;
  facts: readonly PluginCapabilityFact[];
  runnable: boolean;
}

export function pluginCapabilityLabel(capability: PluginCapabilityReference): string {
  return `${capability.scope}.${capability.name}`;
}

function capabilityProviders(
  plugin: PluginDefinition | undefined,
  capability: PluginCapabilityReference,
): readonly string[] {
  if (!plugin) return [];
  if (capability.scope === "extension") return [...new Set(plugin.services.extensions(capability.name).map(item => item.service.name))];
  return plugin.services.services.filter(service => capability.name === "dataSources" ? Boolean(service.dataSources?.length) : service.logs !== undefined).map(service => service.name);
}

export function evaluatePluginCapabilities(
  plugin: PluginDefinition | undefined,
  contract: PluginCapabilityContract,
): PluginCapabilityEvaluation {
  const facts = contract.needs.map((need): PluginCapabilityFact => {
    const providers = capabilityProviders(plugin, need.capability);
    return { need, providers, available: providers.length > 0 };
  });
  return {
    plugin,
    contract,
    facts,
    runnable: plugin !== undefined && facts.every(
      (fact) => fact.need.requirement !== "required" || fact.available,
    ),
  };
}
