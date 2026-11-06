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

/** Complete consumer location; a bare name requires a separate lookup and is not a declaration. */
export function validateWorkloadDeclaration(value: Workload): void {
  const text = (value: unknown) => typeof value === "string" && !!value.trim();
  if (!value || typeof value !== "object" || !text(value.name) || value.platform !== "kubernetes"
    || (value.namespace !== undefined && !text(value.namespace)) || (value.container !== undefined && !text(value.container))) {
    throw new Error("Expected a complete consumer Workload declaration");
  }
  const location = value.location;
  if (!location || (location.kind === "labels" ? !location.labels || !Object.keys(location.labels).length
    || Object.entries(location.labels).some(([key, item]) => !text(key) || typeof item !== "string")
    : location.kind === "service" ? !text(location.name)
    : location.kind === "resource" ? !text(location.name) || !["Deployment", "StatefulSet", "DaemonSet", "Pod"].includes(location.resource_kind)
    : true)) throw new Error(`${value.name}: invalid Workload location`);
}
