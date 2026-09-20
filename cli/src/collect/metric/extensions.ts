import {
  METRIC_CONFIGURATION_KIND, requireMetricConfigurationExtension, metricConfigurationOutput,
  type MetricConfiguration, type ServiceCatalog,
} from "@compforge/doctor-plugin";
import { KubectlExecutor, type Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import { resolveKubernetesCommandContext, type CommandContext } from "../../command";
import { createHostPluginContext, openPluginContext } from "../../plugin/context";
import { invokeExtension } from "../../plugin/extension";
import type { MetricConfig } from "./model";

export function metricConfigurationProviders(catalog: ServiceCatalog) {
  const seen = new Set<string>();
  return catalog.extensions(METRIC_CONFIGURATION_KIND).map(({ service, extension }) => {
    if (seen.has(service.name)) throw new Error(`${service.name}: ambiguous ${METRIC_CONFIGURATION_KIND} Extension`);
    seen.add(service.name);
    return { service, extension: requireMetricConfigurationExtension(extension) };
  });
}

/** Resolve once before scraping; probes and detectors consume the same configuration snapshot. */
export async function loadMetricConfigurations(
  config: MetricConfig,
  catalog: ServiceCatalog,
  command: CommandContext,
  injectedExecutor?: Executor,
): Promise<ReadonlyMap<string, MetricConfiguration>> {
  const providers = metricConfigurationProviders(catalog);
  const configurations = new Map<string, MetricConfiguration>();
  for (const name of config.services) {
    command.signal.throwIfAborted();
    const provider = providers.find(item => item.service.name === name);
    if (!provider) throw new Error(`No metric.configuration Extension for Service '${name}'`);
    const { service, extension } = provider;
    const options = { service, capability: extension, config: command.profile.pluginConfig, clients: command.clients, signal: command.signal };
    const executor = injectedExecutor ?? new KubectlExecutor(config.kube);
    const context = extension.access.kubernetes?.length
      ? await openPluginContext(executor, config.kube, {
        ...options, command: "doctor metric", authorization: resolveKubernetesCommandContext(executor, command).access,
      })
      : createHostPluginContext({ ...options, namespace: config.namespace });
    try {
      configurations.set(name, metricConfigurationOutput(await invokeExtension(extension, context, undefined)));
    } finally {
      await context.dispose();
    }
  }
  return configurations;
}
