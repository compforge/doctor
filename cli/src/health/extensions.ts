import { CASE_CONSUME_KIND, requireCaseConsumeExtension, type CaseConsumeExtension, type PluginDefinition, type ServiceDefinition } from "@compforge/doctor-plugin";
import { createDoctorExtensionRegistry } from "../plugin/extension-registry";
import { overviewScopes, overviewStatistics, type OverviewProvider } from "../overview/extensions";

export interface HealthProvider extends OverviewProvider {
  consumers: readonly CaseConsumeExtension[];
  caseService?: ServiceDefinition;
}

export function healthProviders(plugin: PluginDefinition, serviceNames?: readonly string[]): HealthProvider[] {
  const registry = createDoctorExtensionRegistry(plugin);
  return overviewScopes(plugin, serviceNames).map(scope => {
    const statistics = overviewStatistics(registry, scope);
    const consumers = scope.service ? registry.extensions(CASE_CONSUME_KIND, scope.namespace).map(entry => {
      if (entry.service !== scope.service) throw new Error(`${scope.namespace}: case.consume must belong to the selected Service`);
      return requireCaseConsumeExtension(entry.extension);
    }) : [];
    if (!statistics && !consumers.length) throw new Error(`${scope.namespace}: 未声明 overview.summarize、overview.cost 或 case.consume Extension；可使用 --service 选择体检 Service`);
    return { ...(statistics ?? { namespace: scope.namespace, name: scope.name, service: scope.service! }),
      consumers, caseService: scope.service };
  });
}
