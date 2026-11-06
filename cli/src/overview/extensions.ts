import {
  FACET_SUMMARIZE_KIND, FACET_SAMPLE_KIND, DURATION_SUMMARIZE_KIND, extensionNamespace,
  requireFacetSummarizeExtension, requireFacetSampleExtension, requireDurationSummarizeExtension,
  type DurationSummarizeExtension, type FacetSummarizeExtension, type FacetSampleExtension, type PluginDefinition, type ServiceDefinition,
} from "@compforge/doctor-plugin";
import { createDoctorExtensionRegistry } from "../plugin/extension-registry";

export interface OverviewProvider {
  namespace: string;
  name: string;
  /** Providing Service retained by registration; namespace never selects a data target. */
  service: ServiceDefinition;
  summarize?: FacetSummarizeExtension;
  cost?: DurationSummarizeExtension;
  costService?: ServiceDefinition;
  sample?: FacetSampleExtension;
  sampleService?: ServiceDefinition;
}

export interface OverviewScope {
  namespace: string;
  name: string;
  service?: ServiceDefinition;
}

/** No service selection means the Plugin's own overview, not all Service summaries. */
export function overviewScopes(plugin: PluginDefinition, serviceNames?: readonly string[]): OverviewScope[] {
  if (serviceNames && !serviceNames.length) throw new Error("Overview Service selection must not be empty");
  return serviceNames
    ? plugin.services.resolveNames(serviceNames).map(name => ({
      namespace: extensionNamespace("plugin", plugin.id, "service", name), name, service: plugin.services.find(name),
    }))
    : [{ namespace: extensionNamespace("plugin", plugin.id), name: plugin.id }];
}

/** Discover statistics without preparing or validating unrelated sampling/Case capabilities. */
export function overviewStatistics(
  registry: ReturnType<typeof createDoctorExtensionRegistry>, scope: OverviewScope,
): OverviewProvider | undefined {
  const summaries = registry.extensions(FACET_SUMMARIZE_KIND, scope.namespace);
  const costs = registry.extensions(DURATION_SUMMARIZE_KIND, scope.namespace);
  if (summaries.length > 1 || costs.length > 1) throw new Error(`${scope.namespace}: ambiguous overview Extension`);
  if (!summaries.length && !costs.length) return undefined;
  const summarize = summaries[0] ? requireFacetSummarizeExtension(summaries[0].extension) : undefined;
  const cost = costs[0] ? requireDurationSummarizeExtension(costs[0].extension) : undefined;
  const service = (summaries[0] ?? costs[0])?.service;
  if (!service || (cost && !costs[0]?.service)) throw new Error(`${scope.namespace}: executable overview Extensions require a providing Service`);
  return { namespace: scope.namespace, name: scope.name, service, summarize, cost, costService: costs[0]?.service };
}

/** @spec Overview shows statistics even without sampling; optional samples belong to the same exact namespace. */
export function overviewProviders(plugin: PluginDefinition, serviceNames?: readonly string[]): OverviewProvider[] {
  const registry = createDoctorExtensionRegistry(plugin);
  return overviewScopes(plugin, serviceNames).map(scope => {
    const statistics = overviewStatistics(registry, scope);
    if (!statistics) throw new Error(`${scope.namespace}: 未声明 facet.summarize 或 duration.summarize；可使用 --service 选择提供统计的 Service`);
    const samples = registry.extensions(FACET_SAMPLE_KIND, scope.namespace);
    if (samples.length > 1) throw new Error(`${scope.namespace}: ambiguous overview Extension`);
    const sample = samples[0] ? requireFacetSampleExtension(samples[0].extension) : undefined;
    const sampleService = samples[0]?.service;
    if (sample && !sampleService) throw new Error(`${scope.namespace}: executable overview Extensions require a providing Service`);
    return { ...statistics, sample, sampleService };
  });
}
