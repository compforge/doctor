import type { KubernetesEndpoint } from "./endpoint";

export interface KubernetesPod {
  kind: "pod";
  namespace: string;
  name: string;
  ip?: string;
  phase: string;
  labels: Record<string, string>;
  containers: KubernetesPodContainer[];
}

export interface KubernetesPodContainer {
  name: string;
  restartCount: number;
  hasPreviousTerminated: boolean;
}

interface KubernetesPodList {
  items?: Array<{
    metadata?: { namespace?: string; name?: string; labels?: Record<string, string> };
    status?: {
      podIP?: string;
      phase?: string;
      containerStatuses?: Array<{
        name?: string;
        restartCount?: number;
        lastState?: { terminated?: { containerID?: string } };
      }>;
    };
  }>;
}

export function parsePods(raw: string, defaultNamespace: string): KubernetesPod[] {
  const value = JSON.parse(raw) as KubernetesPodList;
  return (value.items ?? []).flatMap((item) => {
    const name = item.metadata?.name;
    if (!name) return [];
    return [{
      kind: "pod",
      namespace: item.metadata?.namespace ?? defaultNamespace,
      name,
      ip: item.status?.podIP,
      phase: item.status?.phase ?? "Unknown",
      labels: item.metadata?.labels ?? {},
      containers: (item.status?.containerStatuses ?? []).flatMap((container) => {
        const containerName = container.name?.trim();
        if (!containerName) return [];
        return [{
          name: containerName,
          restartCount: container.restartCount ?? 0,
          hasPreviousTerminated: !!container.lastState?.terminated?.containerID,
        }];
      }),
    }];
  });
}

export function findPod(
  pods: readonly KubernetesPod[],
  endpoint: KubernetesEndpoint,
  defaultNamespace: string,
): KubernetesPod | undefined {
  const host = endpoint.host.replace(/\.$/, "");
  const labels = host.split(".");
  const dnsNamespace = labels.length >= 4 && labels[3] === "svc" ? labels[2] : undefined;
  return pods.find((pod) =>
    pod.namespace === (dnsNamespace ?? defaultNamespace)
    && (pod.ip === host || pod.name === host || host.startsWith(`${pod.name}.`))
  );
}
