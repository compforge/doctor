import {
  OVERVIEW_SUMMARIZE_KIND, OVERVIEW_SAMPLE_KIND, extensionNamespace,
  requireOverviewSummarizeExtension, requireOverviewSampleExtension,
  type OverviewSummarizeExtension, type OverviewSampleExtension, type PluginDefinition, type ServiceDefinition,
} from "@compforge/doctor-plugin";
import { createDoctorExtensionRegistry } from "../plugin/extension-registry";

export interface OverviewProvider {
  namespace: string;
  name: string;
  /** Providing Service retained by registration; namespace never selects a data target. */
  service: ServiceDefinition;
  summarize: OverviewSummarizeExtension;
  sample?: OverviewSampleExtension;
  sampleService?: ServiceDefinition;
}

/**
 * @spec No service selection means the Plugin's own overview, never an aggregate of Service summaries.
 * @spec Summary and sample pair only within the same exact namespace.
 */
export function overviewProviders(plugin: PluginDefinition, serviceNames?: readonly string[]): OverviewProvider[] {
  if (serviceNames && !serviceNames.length) throw new Error("Overview Service selection must not be empty");
  const registry = createDoctorExtensionRegistry(plugin);
  const scopes = serviceNames
    ? plugin.services.resolveNames(serviceNames).map(name => ({
      namespace: extensionNamespace("plugin", plugin.id, "service", name), name, service: plugin.services.find(name),
    }))
    : [{ namespace: extensionNamespace("plugin", plugin.id), name: plugin.id, service: undefined }];
  return scopes.map(scope => {
    const summaries = registry.extensions(OVERVIEW_SUMMARIZE_KIND, scope.namespace);
    const samples = registry.extensions(OVERVIEW_SAMPLE_KIND, scope.namespace);
    if (!summaries.length) throw new Error(`${scope.namespace}: 未声明 overview.summarize Extension${scope.service ? "" : "；可使用 --service 选择已声明概览的 Service"}`);
    if (summaries.length > 1 || samples.length > 1) throw new Error(`${scope.namespace}: ambiguous overview Extension`);
    const summarize = requireOverviewSummarizeExtension(summaries[0]!.extension);
    const sample = samples[0] ? requireOverviewSampleExtension(samples[0].extension) : undefined;
    const service = summaries[0]!.service;
    const sampleService = samples[0]?.service;
    if (!service || (sample && !sampleService)) throw new Error(`${scope.namespace}: executable overview Extensions require a providing Service`);
    return { namespace: scope.namespace, name: scope.name, service, summarize, sample, sampleService };
  });
}
