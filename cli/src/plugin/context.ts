import type {
  DatabaseIdentity,
  PluginContext,
} from "@compforge/doctor-plugin";
import type { Executor, KubectlOptions } from "../infra/k8s/executor";
import { ServicePortForwarder } from "../infra/k8s/service-port-forward";

/** Create one Doctor-owned context whose resources live for a single capability command. */
export function createPluginContext(
  executor: Executor,
  kube: KubectlOptions & { namespace: string },
  options: {
    profileName: string;
    databaseIdentity?: DatabaseIdentity;
    service: PluginContext["service"];
  },
): PluginContext & { dispose(): Promise<void> } {
  const controller = new AbortController();
  const disposers: Array<() => void | Promise<void>> = [];
  let forwarder: Promise<ServicePortForwarder> | undefined;
  const context: PluginContext & { dispose(): Promise<void> } = {
    profileName: options.profileName,
    databaseIdentity: options.databaseIdentity,
    kubeconfig: kube.kubeconfig,
    kubeContext: kube.context,
    namespace: kube.namespace,
    service: options.service,
    signal: controller.signal,
    portForward: async (target) => {
      forwarder ??= ServicePortForwarder.create(executor, kube);
      return await (await forwarder).forward(target);
    },
    onDispose: (disposer) => disposers.push(disposer),
    dispose: async () => {
      controller.abort();
      const settled = await Promise.allSettled(disposers.reverse().map((dispose) => dispose()));
      (await forwarder)?.stop();
      const failure = settled.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    },
  };
  return context;
}
