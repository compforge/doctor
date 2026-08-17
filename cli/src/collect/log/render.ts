import stripAnsi from "strip-ansi";
import type {
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

export function renderLogResult(
  config: LogProbeConfig,
  facts: LogInspectionFacts,
  observations: readonly ServiceLogObservation[],
): LogRenderResult {
  const stats = observations.reduce((total, service) => {
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
    total.failedCount += service.pods.filter((pod) => pod.failed).length;
    return total;
  }, { podCount: 0, matchedEventCount: 0, previousContainerCount: 0, failedCount: 0 });
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
    `- 扫描 pod: ${stats.podCount}  命中日志事件: ${stats.matchedEventCount}  previous 容器: ${stats.previousContainerCount}  采集失败 pod: ${stats.failedCount}`,
    `- 时间窗口: ${config.sinceTime ? `since-time=${config.sinceTime}` : `since=${config.since}`}`,
    `- 过滤: ${config.errorsOnly ? "errors-only" : "全部 trace 日志"}${config.pattern ? ` + /${config.pattern}/` : ""}`,
    "",
    "结构化时间线见 `timeline.jsonl`，聚合文本见 `service-logs.txt`；逐 pod 原始证据见 `raw/`。",
  ];
  if (stats.podCount === 0) {
    lines.push("", "> 未找到目标服务的运行中 pod；请确认 namespace 与 --services。");
  } else if (stats.matchedEventCount === 0) {
    lines.push("", "> 未命中日志；可能已超出 pod 日志保留期，或 trace 未经过这些服务。");
  }
  return { timeline, serviceLogs, summary: lines.join("\n"), stats };
}
