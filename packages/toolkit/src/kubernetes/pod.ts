import type { KubernetesEndpoint } from "./endpoint";

export interface KubernetesPod {
  kind: "pod";
  namespace: string;
  name: string;
  serviceAccountName: string;
  ip?: string;
  phase: string;
  reason?: string;
  message?: string;
  conditions: KubernetesPodCondition[];
  labels: Record<string, string>;
  containers: KubernetesPodContainer[];
}

export interface KubernetesPodCondition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

export type KubernetesContainerState =
  | { kind: "waiting"; reason?: string; message?: string }
  | { kind: "running"; startedAt?: string }
  | ({ kind: "terminated" } & KubernetesContainerTermination);

export interface KubernetesContainerTermination {
  exitCode?: number;
  signal?: number;
  reason?: string;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
  containerId?: string;
}

export interface KubernetesPodContainer {
  name: string;
  image: string;
  imageId?: string;
  ports?: Array<{ name?: string; containerPort: number }>;
  requests: Record<string, string>;
  limits: Record<string, string>;
  ready?: boolean;
  started?: boolean;
  restartCount: number;
  state?: KubernetesContainerState;
  lastTermination?: KubernetesContainerTermination;
  hasPreviousTerminated: boolean;
}

interface RawContainerTermination {
  exitCode?: number;
  signal?: number;
  reason?: string;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
  containerID?: string;
}

interface RawContainerStatus {
  name?: string;
  imageID?: string;
  ready?: boolean;
  started?: boolean;
  restartCount?: number;
  state?: {
    waiting?: { reason?: string; message?: string };
    running?: { startedAt?: string };
    terminated?: RawContainerTermination;
  };
  lastState?: { terminated?: RawContainerTermination };
}

interface KubernetesPodList {
  items?: Array<{
    metadata?: { namespace?: string; name?: string; labels?: Record<string, string> };
    spec?: {
      serviceAccountName?: string;
      serviceAccount?: string;
      containers?: Array<{
        name?: string;
        image?: string;
        ports?: Array<{ name?: string; containerPort?: number }>;
        resources?: {
          requests?: Record<string, string>;
          limits?: Record<string, string>;
        };
      }>;
    };
    status?: {
      podIP?: string;
      phase?: string;
      reason?: string;
      message?: string;
      conditions?: Array<{
        type?: string;
        status?: string;
        reason?: string;
        message?: string;
        lastTransitionTime?: string;
      }>;
      containerStatuses?: RawContainerStatus[];
    };
  }>;
}

function termination(raw: RawContainerTermination | undefined): KubernetesContainerTermination | undefined {
  if (!raw) return undefined;
  return {
    exitCode: raw.exitCode,
    signal: raw.signal,
    reason: raw.reason,
    message: raw.message,
    startedAt: raw.startedAt,
    finishedAt: raw.finishedAt,
    containerId: raw.containerID,
  };
}

function containerState(raw: RawContainerStatus["state"]): KubernetesContainerState | undefined {
  if (raw?.waiting) {
    return { kind: "waiting", reason: raw.waiting.reason, message: raw.waiting.message };
  }
  if (raw?.running) return { kind: "running", startedAt: raw.running.startedAt };
  const terminated = termination(raw?.terminated);
  return terminated ? { kind: "terminated", ...terminated } : undefined;
}

export function parsePods(raw: string, defaultNamespace: string): KubernetesPod[] {
  const value = JSON.parse(raw) as KubernetesPodList;
  return (value.items ?? []).flatMap((item) => {
    const name = item.metadata?.name;
    if (!name) return [];
    const statusByName = new Map((item.status?.containerStatuses ?? []).flatMap((container) => {
      const containerName = container.name?.trim();
      return containerName ? [[containerName, container] as const] : [];
    }));
    const declaredContainers = (item.spec?.containers ?? []).flatMap((container) => {
      const containerName = container.name?.trim();
      if (!containerName) return [];
      const status = statusByName.get(containerName);
      const ports = (container.ports ?? []).flatMap((port) =>
        Number.isInteger(port.containerPort)
          ? [{ name: port.name, containerPort: port.containerPort! }]
          : []
      );
      return [{
        name: containerName,
        image: container.image?.trim() ?? "",
        imageId: status?.imageID?.trim() || undefined,
        ...(ports.length ? { ports } : {}),
        requests: container.resources?.requests ?? {},
        limits: container.resources?.limits ?? {},
        ready: status?.ready,
        started: status?.started,
        restartCount: status?.restartCount ?? 0,
        state: containerState(status?.state),
        lastTermination: termination(status?.lastState?.terminated),
        hasPreviousTerminated: !!status?.lastState?.terminated?.containerID,
      }];
    });
    return [{
      kind: "pod",
      namespace: item.metadata?.namespace ?? defaultNamespace,
      name,
      serviceAccountName: item.spec?.serviceAccountName?.trim()
        || item.spec?.serviceAccount?.trim()
        || "default",
      ip: item.status?.podIP,
      phase: item.status?.phase ?? "Unknown",
      reason: item.status?.reason,
      message: item.status?.message,
      conditions: (item.status?.conditions ?? []).flatMap((condition) =>
        condition.type && condition.status
          ? [{
              type: condition.type,
              status: condition.status,
              reason: condition.reason,
              message: condition.message,
              lastTransitionTime: condition.lastTransitionTime,
            }]
          : []
      ),
      labels: item.metadata?.labels ?? {},
      containers: declaredContainers.length > 0 ? declaredContainers : (item.status?.containerStatuses ?? []).flatMap((container) => {
        const containerName = container.name?.trim();
        if (!containerName) return [];
        return [{
          name: containerName,
          image: "",
          imageId: container.imageID?.trim() || undefined,
          requests: {},
          limits: {},
          ready: container.ready,
          started: container.started,
          restartCount: container.restartCount ?? 0,
          state: containerState(container.state),
          lastTermination: termination(container.lastState?.terminated),
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
