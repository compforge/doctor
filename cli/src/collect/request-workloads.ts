import {
  REQUEST_WORKLOADS_KIND, createServiceCatalog, requireRequestWorkloadsExtension, validateWorkloadDeclaration,
  type ServiceCatalog, type Workload,
} from "@compforge/doctor-plugin";
import type { Executor, KubectlOptions } from "@compforge/harness-toolbox/kubernetes/executor";
import type { Summary } from "@compforge/harness-common";
import { isDeepStrictEqual } from "node:util";
import { defineCommandDecision, type CommandContext } from "../command";
import { createHostPluginContext, openPluginContext } from "../plugin/context";
import { invokeExtension } from "../plugin/extension";

export interface RequestWorkloads {
  summaries: Record<string, Summary>;
  catalog: ServiceCatalog;
  owners: ReadonlySet<string>;
  gaps: readonly string[];
}

const decision = defineCommandDecision<RequestWorkloads>(REQUEST_WORKLOADS_KIND);

/** @spec Inspect and Log share the same declarations for one environment and business request. */
export function resolveRequestWorkloads(command: CommandContext, catalog: ServiceCatalog, bizId: string,
  executor: Executor, kube: KubectlOptions & { namespace: string }): Promise<RequestWorkloads> {
  return command.decide(decision, [kube.kubeconfig ?? "", kube.context ?? "", kube.namespace, bizId], async () => {
    const declarations = new Map<string, Map<string, Workload>>();
    const conflicts = new Set<string>();
    const gaps: string[] = [];
    const summaries: RequestWorkloads["summaries"] = Object.create(null);
    for (const { service, extension } of catalog.extensions(REQUEST_WORKLOADS_KIND)) {
      command.signal.throwIfAborted();
      if (!declarations.has(service.name)) declarations.set(service.name, new Map());
      try {
        const provider = requireRequestWorkloadsExtension(extension);
        const options = { service, capability: provider, config: command.profile.pluginConfig,
          clients: command.clients, signal: command.signal };
        const context = provider.access.kubernetes?.length ? await openPluginContext(executor, kube, options)
          : createHostPluginContext({ ...options, namespace: kube.namespace });
        const result = await invokeExtension(provider, context, { bizId }).finally(() => context.dispose());
        if (!Array.isArray(result.data)) throw new Error("expected a Workload array");
        const targets = result.data.map((workload: Workload) => {
          validateWorkloadDeclaration(workload);
          const owner = workload.service ?? service.name;
          if (catalog.find(owner)?.name !== owner) throw new Error(`unknown owner '${owner}'`);
          return { ...workload, service: owner };
        });
        summaries[`${service.name}/${extension.id}`] = result.summary;
        for (const workload of targets) {
          const owner = workload.service;
          const key = JSON.stringify([owner, workload.name]);
          if (conflicts.has(key)) continue;
          const group = declarations.get(owner) ?? new Map<string, Workload>();
          const previous = group.get(workload.name);
          if (previous && !isDeepStrictEqual(previous, workload)) {
            group.delete(workload.name);
            conflicts.add(key);
            gaps.push(`${bizId}: conflicting Workload ${owner}/${workload.name}`);
          } else {
            group.set(workload.name, workload);
          }
          declarations.set(owner, group);
        }
      } catch (error) {
        command.signal.throwIfAborted();
        gaps.push(`${bizId} ${service.name}/${extension.id} ${REQUEST_WORKLOADS_KIND}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return {
      catalog: createServiceCatalog(catalog.services.map(service => declarations.has(service.name)
        ? { ...service, workloads: [...declarations.get(service.name)!.values()] } : service)),
      owners: new Set(declarations.keys()), gaps, summaries,
    };
  });
}
