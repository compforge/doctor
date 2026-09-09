import type { Executor } from "./executor";
import type { KubernetesEndpoint } from "./endpoint";
import { parsePods, type KubernetesPod } from "./pod";

export interface KubernetesServicePort {
  name?: string;
  port: number;
  targetPort?: string | number;
}

export interface KubernetesService {
  kind: "service";
  namespace: string;
  name: string;
  clusterIP?: string;
  selector: Record<string, string>;
  ports: KubernetesServicePort[];
}

interface KubernetesServiceList {
  items?: Array<{
    metadata?: { namespace?: string; name?: string; labels?: Record<string, string> };
    spec?: {
      clusterIP?: string;
      selector?: Record<string, string>;
      ports?: Array<{ name?: string; port?: number; targetPort?: string | number }>;
    };
  }>;
}

function parseList(raw: string): NonNullable<KubernetesServiceList["items"]> {
  const value = JSON.parse(raw) as KubernetesServiceList;
  return value.items ?? [];
}

export function parseServices(raw: string, defaultNamespace: string): KubernetesService[] {
  return parseList(raw).flatMap((item) => {
    const name = item.metadata?.name;
    if (!name) return [];
    const ports = (item.spec?.ports ?? []).flatMap((port) =>
      Number.isInteger(port.port)
        ? [{ name: port.name, port: port.port!, targetPort: port.targetPort }]
        : []
    );
    return [{
      kind: "service",
      namespace: item.metadata?.namespace ?? defaultNamespace,
      name,
      clusterIP: item.spec?.clusterIP,
      selector: item.spec?.selector ?? {},
      ports,
    }];
  });
}

/** 只接受 Kubernetes 的稳定 Service DNS 形态，避免把普通域名误判成集群资源。 */
export function serviceIdentity(
  host: string,
  defaultNamespace: string,
): { name: string; namespace: string } | undefined {
  const labels = host.replace(/\.$/, "").split(".");
  if (labels.length === 1) return { name: labels[0]!, namespace: defaultNamespace };
  if (labels.length === 2) return { name: labels[0]!, namespace: labels[1]! };
  if (labels.length >= 3 && labels[2] === "svc") {
    return { name: labels[0]!, namespace: labels[1]! };
  }
  return undefined;
}

export function findService(
  services: readonly KubernetesService[],
  endpoint: KubernetesEndpoint,
  defaultNamespace: string,
): KubernetesService | undefined {
  const identity = serviceIdentity(endpoint.host, defaultNamespace);
  return services.find((service) =>
    (identity
      ? service.name === identity.name && service.namespace === identity.namespace
      : service.clusterIP === endpoint.host)
    && service.ports.some((port) => port.port === endpoint.port)
  );
}

/** Pod → Service 保持一对多；选择哪个 Service/port 是调用方的配置确认职责。 */
export function findServicesForPod(
  services: readonly KubernetesService[],
  pod: KubernetesPod,
): KubernetesService[] {
  return services.filter((service) => {
    const selector = Object.entries(service.selector);
    return service.namespace === pod.namespace
      && selector.length > 0
      && selector.every(([name, value]) => pod.labels[name] === value);
  });
}

/** Service → Pod 由 Kubernetes selector 决定，不让上层用 Pod 名称前缀猜测。 */
export function findPodsForService(
  services: readonly KubernetesService[],
  pods: readonly KubernetesPod[],
  serviceName: string,
  namespace: string,
): KubernetesPod[] {
  const service = services.find((item) => item.name === serviceName && item.namespace === namespace);
  if (!service) return [];
  const selector = Object.entries(service.selector);
  if (!selector.length) return [];
  return pods
    .filter((pod) =>
      pod.namespace === namespace
      && pod.phase === "Running"
      && selector.every(([name, value]) => pod.labels[name] === value)
    )
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function listServiceNetwork(
  executor: Executor,
  namespace: string,
): Promise<{ services: KubernetesService[]; pods: KubernetesPod[] }> {
  const [serviceResult, podResult] = await Promise.all([
    executor.run(["get", "services", "-o", "json"], { timeoutMs: 20_000 }),
    executor.run(["get", "pods", "-o", "json"], { timeoutMs: 20_000 }),
  ]);
  if (!serviceResult.ok) {
    throw new Error(`读取 Service 失败：${serviceResult.stderr.trim() || `exit=${serviceResult.exitCode}`}`);
  }
  if (!podResult.ok) {
    throw new Error(`读取 Pod 网络信息失败：${podResult.stderr.trim() || `exit=${podResult.exitCode}`}`);
  }
  return {
    services: parseServices(serviceResult.stdout, namespace),
    pods: parsePods(podResult.stdout, namespace),
  };
}
