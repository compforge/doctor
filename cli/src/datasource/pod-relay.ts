import { clientKey, type ClientManager } from "@compforge/harness-common";
import { PodRelayTransport } from "@compforge/harness-toolbox/transport";
import type { Executor, KubectlOptions } from "@compforge/harness-toolbox/kubernetes/executor";

/** @spec Core and Plugin clients borrow one relay per cluster/namespace; the root owns cleanup. */
export function sharedPodRelay(
  clients: Pick<ClientManager, "get">,
  kube: KubectlOptions & { namespace: string },
  executor?: Executor,
): Promise<PodRelayTransport> {
  const target = { kubeconfig: kube.kubeconfig, context: kube.context, namespace: kube.namespace };
  return clients.get({
    clientKey: clientKey("pod-relay", target),
    createClient: (_clients, signal) => new PodRelayTransport({
      ...target, signal, startupTimeoutMs: 10_000, connectTimeoutMs: 10_000,
      maxConnections: 32, maxTargets: 32, maxCandidatePods: 16,
    }, executor ? { executor } : undefined),
  });
}
