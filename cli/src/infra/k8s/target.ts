// K8s 目标解析：Pod JSON → 结构化 Pod / container。
// 多容器时不静默选择，避免诊断命令落到错误业务容器。

export interface ContainerInfo {
  name: string;
  image: string;
  /** Runtime-resolved image reference; unlike spec.image, this may identify the selected child manifest. */
  imageId?: string;
  restartCount: number;
  ready?: boolean;
  limits?: Record<string, string>;
  requests?: Record<string, string>;
  ports?: Array<{ name?: string; containerPort: number }>;
  livenessProbe?: {
    httpGet?: {
      path?: string;
      port?: string | number;
      scheme?: string;
      host?: string;
      httpHeaders?: Array<{ name?: string; value?: string }>;
    };
    periodSeconds?: number;
    failureThreshold?: number;
  };
}

export interface TargetPod {
  name: string;
  namespace: string;
  phase: string;
  nodeName?: string;
  podIP?: string;
  hostNetwork: boolean;
  labels: Record<string, string>;
  startTime?: string;
  containers: ContainerInfo[];
}

export function parsePodJson(raw: string): TargetPod {
  const doc = JSON.parse(raw) as Record<string, any>;
  const meta = doc.metadata ?? {};
  const spec = doc.spec ?? {};
  const status = doc.status ?? {};
  const statusByName = new Map<string, any>(
    ((status.containerStatuses ?? []) as any[]).map((s) => [s.name, s]),
  );
  const containers: ContainerInfo[] = ((spec.containers ?? []) as any[]).map((c) => {
    const st = statusByName.get(c.name);
    return {
      name: c.name,
      image: c.image ?? "",
      imageId: st?.imageID,
      restartCount: st?.restartCount ?? 0,
      ready: st?.ready,
      limits: c.resources?.limits,
      requests: c.resources?.requests,
      ports: (c.ports ?? []).flatMap((port: any) => Number.isInteger(port.containerPort)
        ? [{ name: typeof port.name === "string" ? port.name : undefined, containerPort: port.containerPort }]
        : []),
      livenessProbe: c.livenessProbe,
    };
  });
  return {
    name: meta.name ?? "",
    namespace: meta.namespace ?? "",
    phase: status.phase ?? "Unknown",
    nodeName: spec.nodeName,
    podIP: status.podIP,
    hostNetwork: spec.hostNetwork === true,
    labels: meta.labels ?? {},
    startTime: status.startTime,
    containers,
  };
}

export type PickResult<T> = { ok: true; value: T; note?: string } | { ok: false; reason: string };

export function pickContainer(pod: TargetPod, flag?: string): PickResult<ContainerInfo> {
  if (flag) {
    const found = pod.containers.find((c) => c.name === flag);
    return found
      ? { ok: true, value: found }
      : { ok: false, reason: `容器 '${flag}' 不存在；候选: ${pod.containers.map((c) => c.name).join(", ")}` };
  }
  if (pod.containers.length === 1) return { ok: true, value: pod.containers[0]! };
  return {
    ok: false,
    reason: `pod 有 ${pod.containers.length} 个容器，请用 -c 指定: ${pod.containers.map((c) => c.name).join(", ")}`,
  };
}
