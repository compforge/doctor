import {
  OVERVIEW_SUMMARIZE_KIND, OVERVIEW_SAMPLE_KIND, OVERVIEW_COST_KIND, extensionNamespace,
  requireOverviewSummarizeExtension, requireOverviewSampleExtension, requireOverviewCostExtension,
  type OverviewCostExtension, type OverviewSummarizeExtension, type OverviewSampleExtension, type PluginDefinition, type ServiceDefinition,
} from "@compforge/doctor-plugin";
import { createDoctorExtensionRegistry } from "../plugin/extension-registry";

export interface OverviewProvider {
  namespace: string;
  name: string;
  /** Providing Service retained by registration; namespace never selects a data target. */
  service: ServiceDefinition;
  summarize?: OverviewSummarizeExtension;
  cost?: OverviewCostExtension;
  costService?: ServiceDefinition;
  sample?: OverviewSampleExtension;
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
  const summaries = registry.extensions(OVERVIEW_SUMMARIZE_KIND, scope.namespace);
  const costs = registry.extensions(OVERVIEW_COST_KIND, scope.namespace);
  if (summaries.length > 1 || costs.length > 1) throw new Error(`${scope.namespace}: ambiguous overview Extension`);
  if (!summaries.length && !costs.length) return undefined;
  const summarize = summaries[0] ? requireOverviewSummarizeExtension(summaries[0].extension) : undefined;
  const cost = costs[0] ? requireOverviewCostExtension(costs[0].extension) : undefined;
  const service = (summaries[0] ?? costs[0])?.service;
  if (!service || (cost && !costs[0]?.service)) throw new Error(`${scope.namespace}: executable overview Extensions require a providing Service`);
  return { namespace: scope.namespace, name: scope.name, service, summarize, cost, costService: costs[0]?.service };
}

/** @spec Overview selects objects: it requires a summary/sample pair in the same exact namespace, never cost-only statistics. */
export function overviewProviders(plugin: PluginDefinition, serviceNames?: readonly string[]): OverviewProvider[] {
  const registry = createDoctorExtensionRegistry(plugin);
  return overviewScopes(plugin, serviceNames).map(scope => {
    const summaries = registry.extensions(OVERVIEW_SUMMARIZE_KIND, scope.namespace);
    const samples = registry.extensions(OVERVIEW_SAMPLE_KIND, scope.namespace);
    if (summaries.length > 1 || samples.length > 1) throw new Error(`${scope.namespace}: ambiguous overview Extension`);
    const summarize = summaries[0] ? requireOverviewSummarizeExtension(summaries[0].extension) : undefined;
    const service = summaries[0]?.service;
    if (summarize && !service) throw new Error(`${scope.namespace}: executable overview Extensions require a providing Service`);
    if (!summarize || !samples.length) {
      throw new Error(`${scope.namespace}: 选取数据需要同一 namespace 的 overview.summarize 与 overview.sample；可使用 --service 选择支持下钻的 Service，纯统计请使用 doctor health`);
    }
    const sample = requireOverviewSampleExtension(samples[0]!.extension);
    const sampleService = samples[0]?.service;
    if (sample && !sampleService) throw new Error(`${scope.namespace}: executable overview Extensions require a providing Service`);
    return { namespace: scope.namespace, name: scope.name, service: service!, summarize, sample, sampleService };
  });
}
