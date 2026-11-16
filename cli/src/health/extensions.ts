import { HEALTH_CHECK_KINDS, healthCheckScope, requireHealthCheckExtension,
  type HealthCheckExtension, type HealthScope, type PluginDefinition, type ServiceDefinition } from "@compforge/doctor-plugin";
import { createDoctorExtensionRegistry } from "../plugin/extension-registry";
import { overviewScopes } from "../overview/extensions";

export interface HealthProvider { namespace: string; name: string; service: ServiceDefinition; checks: readonly HealthCheckExtension[]; unsupported?: string }
/** @spec Only explicit Service HealthCheck contributions enter Health; data sources and Collect probes do not opt in implicitly. */
export function healthProviders(plugin: PluginDefinition, serviceNames?: readonly string[], selected?: readonly HealthScope[]): HealthProvider[] {
  const registry = createDoctorExtensionRegistry(plugin);
  const names = serviceNames ?? plugin.services.services.map(service => service.name);
  const providers = overviewScopes(plugin, names).flatMap(scope => {
    if (!scope.service) return [];
    const checks = HEALTH_CHECK_KINDS.flatMap(kind => registry.extensions(kind, scope.namespace).map(entry => {
      if (entry.service !== scope.service) throw new Error(`${scope.name}: HealthCheck must belong to its Service`);
      return requireHealthCheckExtension(entry.extension);
    })).filter(check => !selected || selected.includes(healthCheckScope(check)));
    if (!checks.length && !serviceNames) return [];
    return [{ namespace: scope.namespace, name: scope.name, service: scope.service, checks,
      ...(!checks.length ? { unsupported: "未声明所选 scope 的 HealthCheck" } : {}) }];
  });
  if (!providers.length) throw new Error("当前 Plugin 没有声明所选 scope 的 HealthCheck");
  return providers;
}
