import { servicesWithDataSource, type PluginDefinition } from "@compforge/doctor-plugin";
import { logPluginCapabilities, PLUGIN_COMMAND_CAPABILITIES } from "../command/plugin-command-capabilities";
import { evaluatePluginCapabilities, pluginCapabilityLabel, type PluginCapabilityContract } from "../command/plugin-capability";
import { dataServicesForBizQuery } from "../collect/data/config";
import { inspectServiceCandidates } from "../collect/inspect/options";
import { tenantInspectServices } from "../collect/tenant/services";
import { perfServiceProviders } from "../perf/config";

export interface ServiceCommandDescription {
  name: string;
  purposes: string[];
  /** Missing catalog declarations, not runtime access failures. */
  missingRequirements: string[];
}

/**
 * @spec Command participation is derived from executable contracts and domain selectors, never Plugin-owned command names.
 * @why A contribution is not a CLI command: tenant-only Inspect cannot answer a biz-id Data query.
 * These are offline provider roles, not permission checks or promises that --service is accepted by every command.
 */
export function describeServiceCommands(
  plugin: PluginDefinition, visibleCommands?: ReadonlySet<string>,
): Map<string, ServiceCommandDescription[]> {
  const result = new Map(plugin.services.services.map(service => [service.name, [] as ServiceCommandDescription[]]));
  const data = new Set(dataServicesForBizQuery(plugin.services));
  const databases = new Set(servicesWithDataSource(plugin.services, "db").map(service => service.name));
  const workloads = new Set(inspectServiceCandidates(plugin.services).map(service => service.name));
  const tenantFacts = new Set(tenantInspectServices(plugin.services).map(service => service.name));
  const perf = new Set(perfServiceProviders(plugin.services).map(service => service.name));
  for (const [name, declaration] of Object.entries(PLUGIN_COMMAND_CAPABILITIES)) {
    if (visibleCommands && !visibleCommands.has(name)) continue;
    // Log has a service/time-window mode which does not require trace resolution.
    const contract: PluginCapabilityContract = name === "log" ? logPluginCapabilities(false) : declaration;
    const evaluation = evaluatePluginCapabilities(plugin, contract);
    const missingRequirements = evaluation.facts.filter(fact => fact.need.requirement === "required" && !fact.available)
      .map(fact => pluginCapabilityLabel(fact.need.capability));
    for (const service of plugin.services.services) {
      let purposes = evaluation.facts.filter(fact => {
        if (fact.need.capability.scope === "plugin" || !fact.providers.includes(service.name)) return false;
        if (name === "data") return data.has(service.name);
        if (name === "db") return databases.has(service.name);
        if (name === "store") return !!service.capabilities.dataSources?.length;
        if (name === "eval" && fact.need.capability.name === "inspect") return data.has(service.name);
        if (name === "eval" && fact.need.capability.name === "log") return !!service.capabilities.log?.default;
        if (name === "perf" && ["case", "perf"].includes(fact.need.capability.name)) return perf.has(service.name);
        if (name === "model") {
          const model = plugin.model;
          const provider = fact.need.capability.name === "tenantDirectory" ? model?.tenantDirectoryService
            : fact.need.capability.name === "modelCatalog" ? model?.catalogService : model?.inferenceService;
          return plugin.services.find(provider ?? "")?.name === service.name;
        }
        if (name === "tenant") {
          switch (fact.need.capability.name) {
            case "inspect": return tenantFacts.has(service.name);
            case "tenantDirectory": return plugin.services.find(plugin.tenant?.directoryService ?? "")?.name === service.name;
            case "modelCatalog": return plugin.services.find(plugin.model?.catalogService ?? "")?.name === service.name;
          }
        }
        return true;
      }).map(fact => fact.need.purpose);
      if (name === "data" && purposes.length) purposes = [service.contributions?.inspect?.description ?? purposes[0]!];
      if (name === "inspect" && workloads.has(service.name)) purposes = ["检查声明的 Workload、运行态与配置"];
      if (purposes.length) result.get(service.name)!.push({ name, purposes: [...new Set(purposes)], missingRequirements });
    }
  }
  return result;
}
