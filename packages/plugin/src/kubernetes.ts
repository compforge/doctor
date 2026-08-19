import type { HttpServiceTarget } from "./http";

export type KubernetesAccessRequirement = "required" | "preferred";

export interface KubernetesAccessRule {
  verb: string;
  resource: string;
  resourceName?: string;
  allNamespaces?: boolean;
}

export interface KubernetesAccessNeed {
  rule: KubernetesAccessRule;
  requirement: KubernetesAccessRequirement;
  purpose: string;
  fallback?: string;
}

/** Infrastructure access a Plugin capability asks Core to preflight before invocation. */
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

export interface KubernetesListOptions {
  labelSelector?: string;
}

/** Target-scoped Kubernetes transport owned and policy-controlled by Doctor Core. */
export interface KubernetesAccess {
  /** 派生同一 Target cluster 内指定 namespace 的访问视图；具体 namespace 由 Plugin 自己决定。 */
  inNamespace(namespace: string): KubernetesAccess;
  get<T>(resource: string, name: string): Promise<T>;
  list<T>(resource: string, options?: KubernetesListOptions): Promise<T[]>;
  exec(target: KubernetesExecTarget, command: readonly string[]): Promise<string>;
  portForward(target: HttpServiceTarget): Promise<HttpServiceTarget & { servername?: string }>;
}
