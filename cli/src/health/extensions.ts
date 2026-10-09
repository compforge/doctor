import { CASE_CONSUME_KIND, requireCaseConsumeExtension, type CaseConsumeExtension, type PluginDefinition, type ServiceDefinition } from "@compforge/doctor-plugin";
import { createDoctorExtensionRegistry } from "../plugin/extension-registry";
import { overviewScopes, overviewStatistics, type OverviewProvider } from "../overview/extensions";

export interface HealthProvider extends OverviewProvider {
  consumers: readonly CaseConsumeExtension[];
  caseService?: ServiceDefinition;
}

/** @spec Health selects Service scopes only; omission means every Service with statistics or Case consumers. */
export function healthProviders(plugin: PluginDefinition, serviceNames?: readonly string[]): HealthProvider[] {
  const registry = createDoctorExtensionRegistry(plugin);
  const names = serviceNames ?? plugin.services.services.map(service => service.name);
  const scopes = !serviceNames && !names.length ? [] : overviewScopes(plugin, names);
  const providers = scopes.flatMap(scope => {
    const statistics = overviewStatistics(registry, scope);
    const consumers = scope.service ? registry.extensions(CASE_CONSUME_KIND, scope.namespace).map(entry => {
      if (entry.service !== scope.service) throw new Error(`${scope.namespace}: case.consume must belong to the selected Service`);
      return requireCaseConsumeExtension(entry.extension);
    }) : [];
    if (!statistics && !consumers.length) {
      if (serviceNames) throw new Error(`${scope.namespace}: 未声明 overview.summarize、overview.cost 或 case.consume Extension`);
      return [];
    }
    return [{ ...(statistics ?? { namespace: scope.namespace, name: scope.name, service: scope.service! }),
      consumers, caseService: scope.service }];
  });
  if (!providers.length) throw new Error("当前 Plugin 没有支持 health 的 Service");
  return providers;
}
