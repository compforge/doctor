import type { Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import type { ServiceDefinition } from "@compforge/doctor-plugin";
import type { CommandContext } from "../command";
import type { PodTarget } from "../command/kubernetes-target";
import { discoverKubernetesWorkload } from "../infra/k8s/workload";
import { promptPod, type PodChoice } from "../infra/k8s/pod-selection";
import { promptContainer } from "../infra/k8s/container-selection";
import { resolveUserSelection, type SelectionContext } from "../terminal/selection-context";

/**
 * @spec Configuration comes from a declared Workload instance, never a same-name platform Service.
 * @rule Incomplete discovery cannot prove a unique configuration source; fail before reading credentials.
 */
export async function resolveDataSourceTarget(input: {
  service: ServiceDefinition;
  pod?: string;
  container?: string;
  executor: Executor;
  namespace: string;
  interactive: boolean;
  commandContext: CommandContext;
  selection: SelectionContext;
}): Promise<PodTarget | undefined> {
  const choices = new Map<string, PodChoice>();
  const uids = new Map<string, string>();
  const { environment } = await input.commandContext.environment(input.executor);
  for (const workload of input.service.workloads) {
    const resolved = await discoverKubernetesWorkload(workload, input.executor, input.namespace,
      environment.name, () => {});
    if (resolved.unavailableReason) throw new Error(`${input.service.name}/${workload.name}: ${resolved.unavailableReason}`);
    for (const pod of resolved.pods.filter(pod => pod.phase === "Running")) {
      const instance = resolved.instances.find(instance => instance.pod === pod.name)!;
      if (uids.has(pod.name) && uids.get(pod.name) !== instance.uid) {
        throw new Error(`${input.service.name}/${pod.name}: 配置来源 Pod UID 发生变化，请重试`);
      }
      uids.set(pod.name, instance.uid);
      const containers = pod.containers.filter(container => !workload.container || container.name === workload.container)
        .map(container => ({ name: container.name, image: container.image ?? "" }));
      const choice = choices.get(pod.name) ?? { name: pod.name, phase: pod.phase, ready: "", restarts: 0, containers: [] };
      for (const container of containers) if (!choice.containers.some(item => item.name === container.name)) choice.containers.push(container);
      if (choice.containers.length) choices.set(pod.name, choice);
    }
  }
  const candidates = [...choices.values()].filter(pod => !input.pod || pod.name === input.pod);
  if (!candidates.length) throw new Error(`Service '${input.service.name}' 的 Workload 中没有匹配的 Running Pod${input.pod ? ` '${input.pod}'` : ""}`);
  let pod = candidates[0]!.name;
  if (candidates.length > 1) {
    if (!input.interactive) throw new Error(`Service '${input.service.name}' 有多个 Running Pod；请用 --pod <pod> 指定`);
    const selected = await resolveUserSelection(input.commandContext, input.selection, "Pod", [input.namespace],
      () => promptPod(candidates, { selection: input.selection }));
    if (!selected) return undefined;
    pod = selected;
  }
  const containers = choices.get(pod)!.containers;
  let container = input.container;
  if (container && !containers.some(item => item.name === container)) {
    throw new Error(`${input.service.name}/${pod}: Workload 未声明 Container '${container}'`);
  }
  if (!container && containers.length === 1) container = containers[0]!.name;
  if (!container) {
    if (!input.interactive) throw new Error(`${input.service.name}/${pod}: 请用 --container 指定配置来源`);
    container = await promptContainer(containers, input.selection);
    if (!container) return undefined;
  }
  return { pod, container };
}
