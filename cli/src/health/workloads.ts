import type { ServiceDefinition } from "@compforge/doctor-plugin";
import type { Executor, KubectlOptions } from "@compforge/harness-toolbox/kubernetes/executor";
import type { CommandContext } from "../command";
import { discoverKubernetesWorkload } from "../infra/k8s/workload";
import { enforceKubernetesAccess } from "../terminal/kubernetes-access";

export async function discoverHealthWorkload(service: ServiceDefinition, workloadName: string, context: CommandContext,
  executor: Executor, kubernetes: KubectlOptions & { namespace: string }) {
  const { environment } = await context.environment(executor);
  const workload = service.workloads.find(item => item.name === workloadName);
  if (!workload) throw new Error(`未声明 Workload ${workloadName}`);
  const location = workload.location;
  const resource = location.kind === "service" ? "services" : location.kind === "resource" ? `${location.resource_kind.toLowerCase()}s` : undefined;
  await enforceKubernetesAccess(context.kubernetes(executor).access, { command: "doctor health", needs: [
    { rule: { verb: "list", resource: "pods" }, requirement: "required", purpose: "定位 Health Probe 实例" },
    ...(resource ? [{ rule: { verb: "get", resource, resourceName: location.kind === "labels" ? undefined : location.name },
      requirement: "required" as const, purpose: "解析 Health Probe Workload" }] : []),
  ] });
  const discovered = await discoverKubernetesWorkload(workload, executor, kubernetes.namespace, environment.name, () => {});
  if (discovered.unavailableReason) throw new Error(discovered.unavailableReason);
  if (!discovered.instances.length) throw new Error("未发现实例，无法判断健康状态");
  return discovered;
}
