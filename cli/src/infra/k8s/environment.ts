import { clientKey, type Environment } from "@compforge/harness-common";
import type { Executor, KubectlOptions } from "@compforge/harness-toolbox/kubernetes/executor";
import { currentCommandSignal } from "../../command/execution-scope";

export interface ResolvedKubernetesEnvironment extends Environment {
  readonly kind: "kubernetes";
  readonly context: string;
  readonly server: string;
}

// An executor is bound to its selected transport. Cache only for that execution, never by profile name.
const environments = new WeakMap<Executor, Promise<ResolvedKubernetesEnvironment>>();
export const KUBERNETES_IDENTITY_ARGS = ["config", "view", "--minify", "-o",
  "jsonpath={.current-context}{\"\\n\"}{.clusters[0].cluster.server}"];

/** @spec Identity describes the effective cluster/context, not the profile or kubeconfig filename. */
export function resolveKubernetesEnvironment(executor: Executor, signal = currentCommandSignal()): Promise<ResolvedKubernetesEnvironment> {
  let pending = environments.get(executor);
  if (!pending) {
    pending = (async () => {
      // Select only non-secret fields; never capture credentials or the complete kubeconfig.
      const result = await executor.run([...KUBERNETES_IDENTITY_ARGS], { timeoutMs: 10_000, signal });
      if (!result.ok) throw new Error("无法确认实际 Kubernetes environment：" + (result.stderr.trim() || "config view failed"));
      const [context, server] = result.stdout.trim().split("\n");
      if (!context || !server) throw new Error("Kubernetes environment 缺少 current-context 或 cluster server");
      const endpoint = new URL(server);
      endpoint.username = ""; endpoint.password = "";
      const identity = { context, server: endpoint.toString() };
      return { name: clientKey("kubernetes-environment", identity), kind: "kubernetes" as const, ...identity };
    })();
    environments.set(executor, pending);
  }
  return pending;
}

/** Freeze implicit current-context for every subsequent client using this environment. */
export function bindKubernetesEnvironment<T extends KubectlOptions>(kube: T, environment: ResolvedKubernetesEnvironment): T {
  return { ...kube, context: environment.context };
}
