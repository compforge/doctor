import type { InspectTimeWindow } from "@compforge/doctor-plugin";

// API retention is cluster policy; filter available events by the caller window, never assume a one-hour TTL.
interface ResourceList {
  items?: Array<Record<string, unknown>>;
}

function items(raw: string): Array<Record<string, unknown>> {
  const parsed = JSON.parse(raw) as ResourceList;
  if (!Array.isArray(parsed.items)) throw new Error("Kubernetes list 响应缺少 items");
  return parsed.items;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

export interface KubernetesWorkloadEvent {
  type: string;
  reason: string;
  message: string;
  objectKind: string;
  objectName: string;
  count: number;
  /** 最近一次发生时间（lastTimestamp / eventTime / series.lastObservedTime 归一）。 */
  lastAt?: string;
  firstAt?: string;
}

export interface KubernetesAutoscaler {
  name: string;
  targetKind: string;
  targetName: string;
  minReplicas?: number;
  maxReplicas?: number;
  currentReplicas?: number;
  desiredReplicas?: number;
  /** 形如 "cpu: 1%/80%" 的当前/目标利用率摘要，按 spec.metrics 顺序。 */
  metrics: string[];
}

/** 这些 Normal 事件回答"谁动了 Workload"，与 Warning 同级保留；其余 Normal 是噪声。 */
const LIFECYCLE_NORMAL_REASONS = new Set([
  "Scheduled", "Pulling", "Pulled", "Created", "Started",
  "Killing",
  "ScalingReplicaSet",
  "SuccessfulRescale",
  "SuccessfulCreate",
  "SuccessfulDelete",
]);

/** 单个 inspect 携带的相关事件上限，超出保留最近。 */
export const LIFECYCLE_EVENT_LIMIT = 200;

export function parseKubernetesEvents(raw: string, namespace: string): KubernetesWorkloadEvent[] {
  return items(raw).flatMap((item): KubernetesWorkloadEvent[] => {
    const metadata = record(item.metadata);
    if (text(metadata.namespace) !== undefined && text(metadata.namespace) !== namespace) return [];
    const object = record(item.involvedObject);
    const objectName = text(object.name);
    if (!objectName) return [];
    const series = record(item.series);
    return [{
      type: text(item.type) ?? "Normal",
      reason: text(item.reason) ?? "",
      message: text(item.message) ?? "",
      objectKind: text(object.kind) ?? "",
      objectName,
      count: integer(item.count) ?? integer(series.count) ?? 1,
      firstAt: text(item.firstTimestamp) ?? text(item.eventTime) ?? text(metadata.creationTimestamp) ?? ((integer(series.count) ?? integer(item.count) ?? 1) === 1 ? text(item.lastTimestamp) : undefined),
      lastAt: text(series.lastObservedTime) ?? text(item.lastTimestamp) ?? text(item.eventTime) ?? text(metadata.creationTimestamp) ?? text(item.firstTimestamp),
    }];
  });
}

export function parseKubernetesAutoscalers(raw: string, namespace: string): KubernetesAutoscaler[] {
  return items(raw).flatMap((item): KubernetesAutoscaler[] => {
    const metadata = record(item.metadata);
    if (text(metadata.namespace) !== undefined && text(metadata.namespace) !== namespace) return [];
    const name = text(metadata.name);
    if (!name) return [];
    const spec = record(item.spec);
    const target = record(spec.scaleTargetRef);
    const status = record(item.status);
    const declared = Array.isArray(spec.metrics) ? spec.metrics : [];
    const current = Array.isArray(status.currentMetrics) ? status.currentMetrics : [];
    const metrics = declared.flatMap((entry): string[] => {
      const resource = record(record(entry).resource);
      const resourceName = text(resource.name);
      if (!resourceName) return [];
      const targetUtilization = integer(record(resource.target).averageUtilization);
      const currentEntry = current.find((candidate) =>
        text(record(record(candidate).resource).name) === resourceName);
      const currentUtilization = integer(
        record(record(record(currentEntry ?? {}).resource).current).averageUtilization,
      );
      return [`${resourceName}: ${currentUtilization ?? "?"}%/${targetUtilization ?? "?"}%`];
    });
    return [{
      name,
      targetKind: text(target.kind) ?? "",
      targetName: text(target.name) ?? "",
      minReplicas: integer(spec.minReplicas),
      maxReplicas: integer(spec.maxReplicas),
      currentReplicas: integer(status.currentReplicas),
      desiredReplicas: integer(status.desiredReplicas),
      metrics,
    }];
  });
}

/**
 * 只保留与所选 Workload 对象（Pod/Deployment/HPA 名）相关、且值得出现在诊断现场的事件：
 * 全部 Warning + 生命周期 Normal 白名单，按最近发生排序并截断。
 */
export function selectLifecycleEvents(
  events: readonly KubernetesWorkloadEvent[],
  objectNames: ReadonlySet<string>,
  limit = LIFECYCLE_EVENT_LIMIT,
  timeWindow?: InspectTimeWindow,
): KubernetesWorkloadEvent[] {
  return events
    .filter((event) => objectNames.has(event.objectName)
      && (event.type === "Warning" || LIFECYCLE_NORMAL_REASONS.has(event.reason)))
    // Repeated events describe an interval. Unknown times cannot prove exclusion.
    .filter(event => (!timeWindow?.from || !event.lastAt || !(Date.parse(event.lastAt) < Date.parse(timeWindow.from)))
      && (!timeWindow?.to || !event.firstAt || !(Date.parse(event.firstAt) > Date.parse(timeWindow.to))))
    .sort((left, right) => Date.parse(right.lastAt ?? "") - Date.parse(left.lastAt ?? ""))
    .slice(0, limit)
    .reverse();
}

/** HPA 与 Workload 的关联只看 scaleTargetRef 指向的 Deployment/StatefulSet 名。 */
export function matchAutoscalers(
  autoscalers: readonly KubernetesAutoscaler[],
  targetNames: ReadonlySet<string>,
): KubernetesAutoscaler[] {
  return autoscalers.filter((autoscaler) => targetNames.has(autoscaler.targetName));
}

/**
 * Deployment 管理的 Pod 命名为 <deployment>-<rs-hash>-<pod-hash>（pod-hash 5 位小写字母数字）。
 * 未采集 Deployment 列表时（如未开 --deployment-config），从 Pod 名反推 Deployment 名用于关联
 * HPA/Deployment 级事件；不符合该命名形态（如 StatefulSet 的 <sts>-0）时不猜。
 */
export function deriveDeploymentName(podName: string): string | undefined {
  const segments = podName.split("-");
  if (segments.length < 3) return undefined;
  const podHash = segments[segments.length - 1]!;
  if (!/^[a-z0-9]{5}$/.test(podHash)) return undefined;
  return segments.slice(0, -2).join("-");
}
