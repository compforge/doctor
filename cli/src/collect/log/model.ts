import type { Fact, ObservationMeta } from "../protocol";
import type { EvidenceBundle } from "../evidence";
import type { KubernetesPodLogAccess } from "../../infra/k8s/pod-log";
import type { CommandContext } from "../../command";

export interface LogCollectOptions {
  bizId?: string;
  traceIds?: readonly string[];
  /** @deprecated Use traceIds. */
  traceId?: string;
  namespace: string;
  services: string[];
  since?: string;
  sinceTime?: string;
  errorsOnly: boolean;
  pattern?: string;
  outputDir: string;
}

export interface LogProbeConfig extends Omit<LogCollectOptions, "traceIds"> {
  traceIds: readonly string[];
  linePattern?: RegExp;
}

export interface LogInspectionFacts {
  runtime: Fact<{ kubectlVersion?: string }>;
  servicePods: Fact<{
    byService: Record<string, string[]>;
    previousContainersByPod: Record<string, string[]>;
  }>;
}

export interface PreviousContainerLogObservation {
  container: string;
  events: readonly string[];
}

export interface PodLogObservation {
  pod: string;
  /** 过滤后的逻辑日志事件；堆栈在单个 event 内保留为多行。 */
  events: readonly string[];
  previous?: readonly PreviousContainerLogObservation[];
  failed: boolean;
}

export interface ServiceLogObservation extends ObservationMeta {
  kind: "service-log";
  service: string;
  pods: readonly PodLogObservation[];
}

/** raw Pod 日志经 ID 过滤后的结构化投影；TXT 与 HTML renderer 只消费这一份时间线。 */
export interface LogTimelineRecord {
  kind: "log" | "collection_error";
  service: string;
  pod: string;
  container?: string;
  instance: "current" | "previous";
  timestamp?: string;
  message: string;
  sequence: number;
}

export interface LogCommandContext {
  command: CommandContext;
  config: LogProbeConfig;
  access: KubernetesPodLogAccess;
  bundle: EvidenceBundle;
  log: (line: string) => void;
}

export interface LogRenderStats {
  podCount: number;
  matchedEventCount: number;
  previousContainerCount: number;
  failedCount: number;
}

export interface LogRenderResult {
  timeline: readonly LogTimelineRecord[];
  serviceLogs: string;
  summary: string;
  stats: LogRenderStats;
}
