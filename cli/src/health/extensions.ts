import { WORKLOAD_PROBE_KIND, requireWorkloadProbeExtension, type WorkloadProbeExtension, HEALTH_CASE_BINDINGS_KIND, requireHealthCaseBindingsExtension, type HealthCaseBindingsExtension, type PluginDefinition, type ServiceDefinition } from "@compforge/doctor-plugin";
import { serviceHealthDataSources } from "../datasource/health/services";
import type { ServiceDataSourceReference } from "../collect/shared/service-dependency";
import { createDoctorExtensionRegistry } from "../plugin/extension-registry";
import { overviewScopes } from "../overview/extensions";

export interface HealthProvider {
  namespace: string;
  name: string;
  service: ServiceDefinition;
  unsupported?: string;
  consumers: readonly HealthCaseBindingsExtension[];
  probes?: readonly WorkloadProbeExtension[];
  dataSources?: readonly ServiceDataSourceReference[];
  endpoints?: ServiceDefinition["endpoints"];
}

/** @spec Health selects Service scopes only; omission means every Service with Case consumers, supported DataSources or opted-in Health workload Probes. */
export function healthProviders(plugin: PluginDefinition, serviceNames?: readonly string[]): HealthProvider[] {
  const registry = createDoctorExtensionRegistry(plugin);
  const names = serviceNames ?? plugin.services.services.map(service => service.name);
  const scopes = !serviceNames && !names.length ? [] : overviewScopes(plugin, names);
  const providers = scopes.flatMap(scope => {
    const consumers = scope.service ? registry.extensions(HEALTH_CASE_BINDINGS_KIND, scope.namespace).map(entry => {
      if (entry.service !== scope.service) throw new Error(`${scope.namespace}: health.case.bindings must belong to the selected Service`);
      return requireHealthCaseBindingsExtension(entry.extension);
    }) : [];
    const dataSources = scope.service ? serviceHealthDataSources(plugin, scope.service) : [];
    const probes = scope.service ? (scope.service.extensions ?? []).filter(extension => extension.kind === WORKLOAD_PROBE_KIND && (!extension.namespace || extension.namespace === scope.namespace))
      .map(extension => requireWorkloadProbeExtension(extension)).filter(probe => probe.health) : [];
    const endpoints = scope.service?.endpoints;
    if (!consumers.length && !dataSources.length && !probes.length && endpoints === undefined) {
      if (serviceNames) throw new Error(`${scope.namespace}: 未声明 health.case.bindings Extension，也没有可探测的数据源或标注 health: self/deps 的 workload.probe`);
      return [];
    }
    return [{ namespace: scope.namespace, name: scope.name, service: scope.service!,
      consumers, probes, dataSources, endpoints }];
  });
  if (!providers.length) throw new Error("当前 Plugin 没有支持 health 的 Service");
  return providers;
}
