/** A logical Service can own any number of deployable workloads. */
export type WorkloadLifecycle = "persistent" | "ephemeral";

export interface KubernetesServiceWorkloadDiscovery {
  kind: "kubernetes-service";
  /** Kubernetes Service resource name. It is not inferred from the logical Service name. */
  service: string;
}

export interface KubernetesPodsWorkloadDiscovery {
  kind: "kubernetes-pods";
  /** Structured equality labels; Core owns their serialization for Kubernetes. */
  labels: Readonly<Record<string, string>>;
}

export type WorkloadDiscovery =
  | KubernetesServiceWorkloadDiscovery
  | KubernetesPodsWorkloadDiscovery;

/**
 * A deployable process group owned by a logical Service.
 *
 * @spec 业务 Service 身份与 Kubernetes Service 资源解耦，并通过显式 Workload discovery 解析运行实例
 * @case id=pod_selector_without_kubernetes_service,desc=`动态 Pod 没有同名 Kubernetes Service`,expect=`按 label selector 解析 Instance`,forbid=`按业务 Service 名猜 Kubernetes Service`
 * @see {@link cli/tests/workload-discovery.test.ts}
 * @rule Kubernetes Service 只是 discovery variant，不是 ServiceDefinition 的运行时身份
 */
export interface ServiceWorkloadDefinition {
  /** Stable identity within one logical Service. */
  name: string;
  discovery: WorkloadDiscovery;
  lifecycle: WorkloadLifecycle;
  /** Selects the business container when a Pod contains sidecars. */
  container?: string;
}

export interface KubernetesPodWorkloadInstance {
  kind: "kubernetes-pod";
  namespace: string;
  pod: string;
  container?: string;
}

export type WorkloadInstance = KubernetesPodWorkloadInstance;

/** Explicit convenience for the common case; Core never applies it implicitly. */
export function kubernetesServiceWorkload(
  service: string,
  options: {
    name?: string;
    lifecycle?: WorkloadLifecycle;
    container?: string;
  } = {},
): ServiceWorkloadDefinition {
  return {
    name: options.name ?? "main",
    discovery: { kind: "kubernetes-service", service },
    lifecycle: options.lifecycle ?? "persistent",
    container: options.container,
  };
}
