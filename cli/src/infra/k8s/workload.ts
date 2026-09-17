import type { ExecResult, Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import { resolveWorkload } from "@compforge/harness-toolbox/kubernetes/workload";
import type { Resource } from "@compforge/harness-toolbox/kubernetes/resources";
import type { Workload, WorkloadInstance } from "@compforge/doctor-plugin";
import { parsePods, type KubernetesPod } from "@compforge/harness-toolbox/kubernetes/pod";
import { parseServices, type KubernetesService } from "@compforge/harness-toolbox/kubernetes/service";
import { currentCommandSignal } from "../../command/execution-scope";

export interface DiscoveredKubernetesWorkload {
  definition: Workload;
  instances: WorkloadInstance[];
  service?: KubernetesService;
  pods: KubernetesPod[];
  unavailableReason?: string;
}

/**
 * @spec Inspect and Log share toolbox location semantics over the selected Kubernetes transport.
 * @rule A logical Service name is never a platform resource name unless its Workload declares it.
 */
export async function discoverKubernetesWorkload(
  definition: Workload,
  executor: Executor,
  namespace: string,
  environment: string,
  recordCapture: (result: ExecResult) => void,
): Promise<DiscoveredKubernetesWorkload> {
  const selectedNamespace = definition.namespace ?? namespace;
  // Collector access and snapshots are namespace-bound; a declaration must not silently
  // redirect probes or borrow permissions checked against a different namespace.
  if (selectedNamespace !== namespace) return {
    definition, pods: [], instances: [],
    unavailableReason: `Workload 位于 namespace '${selectedNamespace}'；请使用 --namespace ${selectedNamespace} 单独采集`,
  };
  const signal = currentCommandSignal();
  const pods = new Map<string, KubernetesPod>();
  let service: KubernetesService | undefined;
  try {
    const instances = await resolveWorkload({
      get: async (ns, resource, name, selector) => {
        const args = ["get", resource, ...(name ? [name] : []), ...(selector ? ["-l", selector] : []), "-o", "json"];
        const result = await executor.run(args, { timeoutMs: 30_000, signal });
        recordCapture(result);
        if (!result.ok) throw new Error(result.stderr.trim() || "Workload discovery failed");
        const raw = JSON.parse(result.stdout) as Resource;
        const list = name ? JSON.stringify({ items: [raw] }) : result.stdout;
        if (resource === "pods") for (const pod of parsePods(list, ns)) pods.set(pod.name, pod);
        if (resource === "services") service = parseServices(list, ns)[0];
        return raw;
      },
    }, definition, selectedNamespace, environment);
    return { definition, service, instances, pods: instances.map(instance => pods.get(instance.pod)!) };
  } catch (error) {
    signal?.throwIfAborted();
    return { definition, service, pods: [], instances: [],
      unavailableReason: error instanceof Error ? error.message : String(error) };
  }
}
