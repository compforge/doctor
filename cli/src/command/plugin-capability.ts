import type {
  PluginLevelCapabilityName,
  PluginDefinition,
  ServiceCapabilityName,
} from "@compforge/doctor-plugin";

export type PluginCapabilityRequirement = "required" | "preferred";

export type PluginCapabilityReference =
  | { scope: "plugin"; name: PluginLevelCapabilityName }
  | { scope: "service"; name: ServiceCapabilityName };

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
  if (capability.scope === "plugin") {
    return plugin[capability.name] === undefined ? [] : [plugin.id];
  }
  return plugin.services.servicesWith(capability.name).map((service) => service.name);
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
