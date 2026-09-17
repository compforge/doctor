import { createServiceCatalog, type PluginDefinition, type ServiceDefinition } from "@compforge/doctor-plugin";
import type { KubernetesPod } from "@compforge/harness-toolbox/kubernetes/pod";
import type { Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import type { LogWorkloadTarget } from "../src/collect/log/model";

export const logService = (name = "api"): ServiceDefinition => ({
  name, component: { name, repository: { forge: { name: "test" }, path: "fixtures/log" } },
  workloads: [{ name: "main", platform: "kubernetes", location: { kind: "labels", labels: { app: name } } }],
  capabilities: { log: { default: true } },
});
export const logPlugin = (...services: ServiceDefinition[]): PluginDefinition => ({
  id: "log-fixture", version: "1.0.0", services: createServiceCatalog(services.length ? services : [logService()]),
});

export function logTarget(pod: string, hasPrevious = false, namespace = "test"): LogWorkloadTarget {
  return { instance: { platform: "kubernetes", environment: "default", workload: "main",
    namespace, pod, uid: pod + "-uid", container: "app" }, hasPrevious,
    current: JSON.stringify([pod + "-uid", "app-current"]), previous: JSON.stringify([pod + "-uid", "app-previous"]) };
}

export const logIdentityExecutor: Executor = {
  run: async args => ({ ok: true, exitCode: 0, stderr: "", durationMs: 1, timedOut: false, command: args,
    stdout: JSON.stringify({ metadata: { name: args[2], uid: args[2] + "-uid" }, status: {
      containerStatuses: [{ name: "app", containerID: "app-current", lastState: { terminated: { containerID: "app-previous" } } }],
    } }) }),
  exec: async () => { throw new Error("No exec"); },
};

/** Return realistic Pod API objects from the runtime fixtures used by capture tests. */
export function podDiscoveryExecutor(pods: readonly KubernetesPod[], onDiscover = () => {}): Executor {
  return {
    run: async args => {
      if (args[0] === "config") return { ok: true, exitCode: 0, stderr: "", durationMs: 1, timedOut: false, command: args,
        stdout: "test\nhttps://cluster.test" };
      if (args[0] !== "get" || args[1] !== "pods") throw new Error("Unexpected discovery: " + args.join(" "));
      if (args[2]?.startsWith("-")) onDiscover();
      const items = pods.map(pod => ({
        metadata: { name: pod.name, uid: pod.uid, namespace: pod.namespace },
        spec: { containers: pod.containers.map(container => ({ name: container.name })) },
        status: { phase: pod.phase, containerStatuses: pod.containers.map(container => ({
          name: container.name, containerID: container.containerId ?? `${container.name}-current`, restartCount: container.restartCount,
          lastState: container.hasPreviousTerminated ? { terminated: { containerID: container.lastTermination?.containerId ?? `${container.name}-previous` } } : {},
        })) },
      }));
      return { ok: true, exitCode: 0, stderr: "", durationMs: 1, timedOut: false, command: args,
        stdout: JSON.stringify(args[2]?.startsWith("-") ? { items } : items.find(pod => pod.metadata.name === args[2])),
      };
    },
    exec: async () => { throw new Error("Discovery must not exec"); },
  };
}
