import stripAnsi from "strip-ansi";
import type {
  LogDiagnosis,
  LogRenderStats,
  LogInspectionFacts,
  LogProbeConfig,
  LogRenderResult,
  LogTimelineRecord,
  ServiceLogObservation,
} from "./model";

const KUBECTL_LOG_PREFIX = /^\[pod\/[^/\]]+\/([^\]]+)\]\s+/;
const RFC3339_PREFIX = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))\s/;

function parseLogLine(line: string): { container?: string; timestamp?: string; message: string } {
  const container = line.match(KUBECTL_LOG_PREFIX)?.[1];
  const withoutKubernetesPrefix = line.replace(KUBECTL_LOG_PREFIX, "");
  const rawTimestamp = withoutKubernetesPrefix.match(RFC3339_PREFIX)?.[1];
  const timestamp = rawTimestamp && !Number.isNaN(Date.parse(rawTimestamp))
    ? rawTimestamp
    : undefined;
  return {
    container,
    timestamp,
    message: stripAnsi(withoutKubernetesPrefix.replace(RFC3339_PREFIX, "")),
  };
}

function parseLogEvent(event: string): { container?: string; timestamp?: string; message: string } {
  const [first = "", ...continuations] = event.split("\n");
  const parsed = parseLogLine(first);
  return {
    ...parsed,
    message: [parsed.message, ...continuations.map((line) => parseLogLine(line).message)].join("\n"),
  };
}

export function buildLogTimeline(
  observations: readonly ServiceLogObservation[],
): LogTimelineRecord[] {
  const errors: LogTimelineRecord[] = [];
  const timeline: LogTimelineRecord[] = [];
  let sequence = 0;
  for (const observation of observations) {
    for (const pod of observation.pods) {
      for (const event of pod.events) {
        if (event.startsWith("[collect-error")) {
          errors.push({
            kind: "collection_error",
            service: observation.service,
            pod: pod.pod,
            instance: "current",
            message: event,
            sequence: sequence++,
          });
          continue;
        }
        const parsed = parseLogEvent(event);
        timeline.push({
          kind: "log",
          service: observation.service,
          pod: pod.pod,
          container: parsed.container,
          instance: "current",
          timestamp: parsed.timestamp,
          message: parsed.message,
          sequence: sequence++,
        });
      }
      for (const previous of pod.previous ?? []) {
        for (const event of previous.events) {
          const parsed = parseLogEvent(event);
          timeline.push({
            kind: "log",
            service: observation.service,
            pod: pod.pod,
            container: parsed.container ?? previous.container,
            instance: "previous",
            timestamp: parsed.timestamp,
            message: parsed.message,
            sequence: sequence++,
          });
        }
      }
    }
  }
  timeline.sort((left, right) => {
    if (left.timestamp !== undefined && right.timestamp !== undefined) {
      return Date.parse(left.timestamp) - Date.parse(right.timestamp) || left.sequence - right.sequence;
    }
    if (left.timestamp !== undefined) return -1;
    if (right.timestamp !== undefined) return 1;
    return left.sequence - right.sequence;
  });
  return [...errors, ...timeline];
}

export function renderTimelineJsonl(records: readonly LogTimelineRecord[]): string {
  return records.length ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n` : "";
}

export function renderServiceLogs(
  traceIdsInput: string | readonly string[],
  namespace: string,
  services: readonly string[],
  records: readonly LogTimelineRecord[],
): string {
  const traceIds = typeof traceIdsInput === "string" ? [traceIdsInput] : traceIdsInput;
  const lines = [
    `trace_ids=${traceIds.join(",")}`,
    `namespace=${namespace}`,
    `services=${services.join(",")}`,
    "",
  ];
  const errors = records.filter((record) => record.kind === "collection_error");
  const timeline = records.filter((record) => record.kind === "log");
  if (errors.length) {
    lines.push("===== collection errors =====", ...errors.map((record) =>
      `[service/${record.service} pod/${record.pod}] ${record.message}`
    ), "");
  }
  lines.push("===== timeline =====");
  lines.push(...(timeline.length
    ? timeline.map((entry) => {
        const container = entry.container ? ` container/${entry.container}` : "";
        const previous = entry.instance === "previous" ? " instance/previous" : "";
        const timestamp = entry.timestamp ? `${entry.timestamp} ` : "";
        return `[service/${entry.service} pod/${entry.pod}${container}${previous}] ${timestamp}${entry.message}`;
      })
    : ["(no matched log lines)"]));
  return `${lines.join("\n").trimEnd()}\n`;
}

function failureSummary(facts: LogInspectionFacts): string | undefined {
  if (facts.runtime.status !== "collected") {
    return `# log 采集失败\n\n${facts.runtime.reason}\n`;
  }
  if (facts.servicePods.status !== "collected") {
    return `# log 采集失败\n\n${facts.servicePods.reason}\n`;
  }
  return undefined;
}

export function formatLogCaptureStats(stats: LogRenderStats): string {
  const first = stats.firstMatchMs === undefined ? "未命中" : `${(stats.firstMatchMs / 1000).toFixed(2)} s`;
  return `候选 ${stats.podCount} Pod，扫描 ${stats.scannedPodCount} Pod，trace 命中 ${stats.matchedPodCount} Pod；下载 ${(stats.bytesRead / 1024 / 1024).toFixed(2)} MiB；首次命中 ${first}；采集 wall-clock ${(stats.wallMs / 1000).toFixed(2)} s`;
}

export function renderLogResult(
  config: LogProbeConfig,
  diagnosis: LogDiagnosis,
): LogRenderResult {
  const { facts, observations } = diagnosis.evidence;
  const stats = observations.reduce<LogRenderStats>((total, service) => {
    if (service.capture) {
      total.bytesRead += service.capture.bytesRead;
      total.matchedPodCount += service.capture.matchedPodCount;
      total.scannedPodCount += service.capture.scannedPodCount;
      total.wallMs = Math.max(total.wallMs, service.capture.wallMs);
      if (service.capture.firstMatchMs !== undefined) {
        total.firstMatchMs = Math.min(total.firstMatchMs ?? Infinity, service.capture.firstMatchMs);
      }
    }
    total.podCount += service.pods.length;
    total.matchedEventCount += service.pods.reduce(
      (count, pod) => count
        + pod.events.filter((event) => !event.startsWith("[collect-error")).length
        + (pod.previous ?? []).reduce((sum, previous) => sum + previous.events.length, 0),
      0,
    );
    total.previousContainerCount += service.pods.reduce(
      (count, pod) => count + (pod.previous?.length ?? 0),
      0,
    );
    total.partialCount += service.pods.filter((pod) => pod.captureStatus === "partial").length;
    total.unavailableCount += service.pods.filter((pod) => pod.captureStatus === "unavailable").length;
    return total;
  }, {
    bytesRead: 0,
    matchedPodCount: 0,
    scannedPodCount: 0,
    wallMs: 0,
    podCount: 0,
    matchedEventCount: 0,
    previousContainerCount: 0,
    partialCount: 0,
    unavailableCount: 0,
  });
  const timeline = buildLogTimeline(observations);
  const serviceLogs = renderServiceLogs(
    config.traceIds,
    config.namespace,
    config.services,
    timeline,
  );
  const failed = failureSummary(facts);
  if (failed) return { timeline, serviceLogs, summary: failed, stats };

  const lines = [
    `# log 采集摘要：${config.traceIds.join(", ")}`,
    "",
    `- namespace: \`${config.namespace}\``,
    `- services: ${config.services.map((service) => `\`${service}\``).join(", ")}`,
    `- 命中日志事件: ${stats.matchedEventCount}  previous 容器: ${stats.previousContainerCount}  部分采集 pod: ${stats.partialCount}  不可用 pod: ${stats.unavailableCount}`,
    `- ${formatLogCaptureStats(stats)}`,
    `- 时间窗口: ${config.sinceTime ? `since-time=${config.sinceTime}` : `since=${config.since}`}${config.untilTime ? ` until-time=${config.untilTime}（含边界）` : ""}`,
    "- 首次命中按 trace ID 统计，早于错误/内容筛选；采集 wall-clock 从日志采集开始计时，包含 Pod 发现和排队。",
    `- 过滤: ${config.errorsOnly ? "errors-only" : "全部 trace 日志"}${config.pattern ? ` + /${config.pattern}/` : ""}`,
    "",
    "结构化时间线见 `timeline.jsonl`，聚合文本见 `service-logs.txt`；逐 pod 原始证据见 `raw/`。",
  ];
  if (stats.podCount === 0) {
    lines.push("", "> 未找到目标服务的运行中 pod；请确认 namespace 与 --services。");
  } else if (stats.matchedPodCount > 0 && stats.matchedEventCount === 0) {
    lines.push("", "> 找到 trace 日志，但没有日志满足错误/内容筛选条件。");
  } else if (stats.matchedEventCount === 0) {
    lines.push("", "> 未命中日志；可能已超出 pod 日志保留期，或 trace 未经过这些服务。");
  }
  return { timeline, serviceLogs, summary: lines.join("\n"), stats };
}
