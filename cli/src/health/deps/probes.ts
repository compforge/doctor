import { SERVICE_DOWNSTREAMS_KIND, requireServiceDownstreamsExtension,
  type ServiceDefinition, type ServiceDownstream } from "@compforge/doctor-plugin";
import type { Executor, KubectlOptions } from "@compforge/harness-toolbox/kubernetes/executor";
import type { CommandContext } from "../../command";
import type { HealthProvider } from "../extensions";
import { runHealthProbes } from "../probe-runner";
import { caseOperationInvoker } from "../runtime";

export function validateDownstreams(service: ServiceDefinition, services: readonly ServiceDefinition[], values: readonly ServiceDownstream[]): void {
  if (!Array.isArray(values)) throw new Error("service.downstreams 必须返回列表");
  const ids = new Set<string>();
  for (const value of values) {
    if (!value?.id || ids.has(value.id) || !services.some(item => item.name === value.service)
      || !service.workloads.some(workload => workload.name === value.workload)
      || typeof value.endpoint?.host !== "string" || !value.endpoint.host.trim() || /[\s/\\?#@]/.test(value.endpoint.host)
      || !Number.isInteger(value.endpoint.port) || value.endpoint.port < 1 || value.endpoint.port > 65535
      || (value.endpoint.tls !== undefined && typeof value.endpoint.tls !== "boolean")) {
      throw new Error("service.downstreams 返回了无效、未声明或重复的下游关系");
    }
    ids.add(value.id);
  }
}

/** @spec Dependency relations are resolved for the exact consumer instance and business context, immediately before its Probe. */
export function checkDependencyHealthProbes(provider: HealthProvider, context: CommandContext, executor: Executor,
  kubernetes: KubectlOptions & { namespace: string }, bizId?: string) {
  const invoke = caseOperationInvoker(context, executor, kubernetes);
  return runHealthProbes(provider, context, executor, kubernetes, async instance => {
    const downstreams: ServiceDownstream[] = [];
    for (const extension of provider.service.extensions ?? []) {
      if (extension.kind !== SERVICE_DOWNSTREAMS_KIND || (extension.namespace && extension.namespace !== provider.namespace)) continue;
      downstreams.push(...await invoke(provider.service, requireServiceDownstreamsExtension(extension), { instance, bizId }));
    }
    validateDownstreams(provider.service, context.plugin.services.services, downstreams);
    return { bizId, downstreams };
  });
}
