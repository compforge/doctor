import type { FileReadOptions, FileReadResult } from "@compforge/harness-common";
import type { HttpServiceTarget } from "./http";
import type { ResourceRef, ResourceListQuery, ResourceList, ResourceRequestOptions } from "@compforge/harness-toolbox/kubernetes/resources";

export type KubernetesAccessRequirement = "required" | "preferred";

export interface KubernetesAccessRule {
  verb: string;
  resource: string;
  resourceName?: string;
  /** Exact namespace; omitted means the capability target namespace. */
  namespace?: string;
  allNamespaces?: boolean;
}

export interface KubernetesAccessNeed {
  rule: KubernetesAccessRule;
  requirement: KubernetesAccessRequirement;
  purpose: string;
  fallback?: string;
}

/**
 * @spec Core enforces these declarations on each operation; the target system authorizes actual requests.
 * @why Unused fallback paths must not require permissions before the selected path can run.
 * @see {@link cli/docs/plugin.md}
 */
export interface CapabilityAccess {
  kubernetes?: readonly KubernetesAccessNeed[];
}

export interface CapabilityWithAccess {
  /** Keep access explicit even when the capability is infrastructure-independent. */
  access: CapabilityAccess;
}

export interface KubernetesExecTarget {
  pod: string;
  container?: string;
}

export type KubernetesResourceRef = Omit<ResourceRef, "namespace">;
export type KubernetesResourceListQuery = Omit<ResourceListQuery, "namespace">;
export type KubernetesResourceList<T> = Pick<ResourceList, "apiVersion" | "kind" | "metadata"> & { items: T[]; [field: string]: unknown };

/** Target-scoped Kubernetes transport owned and policy-controlled by Doctor Core. */
export interface KubernetesAccess {
  /** 派生同一 Target cluster 内指定 namespace 的访问视图；具体 namespace 由 Plugin 自己决定。 */
  inNamespace(namespace: string): KubernetesAccess;
  /** REST resource identity is explicit; no kubectl aliases or implicit API versions. */
  get<T>(ref: KubernetesResourceRef, options?: ResourceRequestOptions): Promise<T>;
  list<T>(query: KubernetesResourceListQuery): Promise<KubernetesResourceList<T>>;
  exec(target: KubernetesExecTarget, command: readonly string[], options?: { stdin?: string; timeoutMs?: number }): Promise<string>;
  /** One bounded acquisition for a declared file group in one Container; results remain independent per path. */
  readFiles(target: Required<KubernetesExecTarget>, paths: readonly string[], options: FileReadOptions): Promise<readonly FileReadResult[]>;
  /** Borrow an execution-scoped TCP relay through an existing Pod; requires list pods, exec and portforward. */
  podRelay(target: HttpServiceTarget): Promise<HttpServiceTarget & { servername?: string }>;
  portForward(target: HttpServiceTarget): Promise<HttpServiceTarget & { servername?: string }>;
}
