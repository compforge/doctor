import type { Workload } from "@compforge/harness-common";

export type { Workload, WorkloadInstance } from "@compforge/harness-common";

/** Explicit convenience only; logical Service names never imply platform resource names. */
export function kubernetesServiceWorkload(
  service: string,
  options: { name?: string; namespace?: string; container?: string } = {},
): Workload {
  return {
    name: options.name ?? "main",
    platform: "kubernetes",
    location: { kind: "service", name: service },
    namespace: options.namespace,
    container: options.container,
  };
}
