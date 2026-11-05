import {
  LOG_WORKLOADS_KIND, logWorkloadsOutput, requireLogWorkloadsExtension,
  type LogWorkloadsInput, type ServiceCatalog,
} from "@compforge/doctor-plugin";
import type { Summary } from "@compforge/harness-common";
import type { Executor, KubectlOptions } from "@compforge/harness-toolbox/kubernetes/executor";
import type { CommandContext } from "../../command";
import { createHostPluginContext, openPluginContext } from "../../plugin/context";
import { invokeExtension } from "../../plugin/extension";

export interface LogWorkloadSelection {
  readonly workloads: Readonly<Record<string, readonly string[]>>;
  readonly summaries: Readonly<Record<string, Summary>>;
  readonly gaps: readonly string[];
}

/** A provider's lookup is independent of Data Command; Core only consumes declared Workload names. */
export async function resolveLogWorkloads(
  services: readonly string[], inputs: readonly LogWorkloadsInput[], catalog: ServiceCatalog,
  command: CommandContext, executor: Executor, kube: KubectlOptions & { namespace: string },
): Promise<LogWorkloadSelection[]> {
  const selections = inputs.map(() => ({ workloads: {} as Record<string, readonly string[]>,
    summaries: {} as Record<string, Summary>, gaps: [] as string[] }));
  for (const name of services) {
    command.signal.throwIfAborted();
    const service = catalog.find(name)!;
    const providers = catalog.extensions(LOG_WORKLOADS_KIND).filter(provider => provider.service.name === name);
    for (const [index, input] of inputs.entries()) {
      const selection = selections[index]!;
      selection.workloads[name] = [];
      try {
        if (!providers.length) {
          // Only explicitly selected Services can reach this fallback.
          selection.workloads[name] = service.workloads.map(workload => workload.name);
          selection.summaries[name] = { title: "日志 Workload", text: "显式选择 Service 的静态 Workload", fields: [] };
          continue;
        }
        if (providers.length > 1) throw new Error(`ambiguous ${LOG_WORKLOADS_KIND} Extension`);
        const extension = requireLogWorkloadsExtension(providers[0]!.extension);
        const options = { service, capability: extension, config: command.profile.pluginConfig,
          clients: command.clients, signal: command.signal };
        const context = extension.access.kubernetes?.length
          ? await openPluginContext(executor, kube, options)
          : createHostPluginContext({ ...options, namespace: kube.namespace });
        try {
          const result = await invokeExtension(extension, context, input);
          selection.workloads[name] = logWorkloadsOutput(result.data, service.workloads);
          selection.summaries[name] = result.summary;
        } finally {
          await context.dispose();
        }
      } catch (error) {
        command.signal.throwIfAborted();
        selection.workloads[name] = [];
        selection.gaps.push(`${name} log.workloads: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return selections;
}

export function mergeLogWorkloads(selections: readonly Readonly<Record<string, readonly string[]>>[]) {
  const merged: Record<string, string[]> = {};
  for (const selection of selections) for (const [name, workloads] of Object.entries(selection)) {
    merged[name] = [...new Set([...(merged[name] ?? []), ...workloads])];
  }
  return merged;
}
