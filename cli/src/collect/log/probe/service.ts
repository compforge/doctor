import { existsSync } from "node:fs";
import { join } from "node:path";
import { PROBE_RUNNABLE, probeUnavailable, type Probe } from "../../protocol";
import {
  runPodLogCapturePlan,
  type PodLogCapturePlanItem,
} from "../../../infra/k8s/log-capture-plan";
import type {
  PodLogCaptureStatus,
  PodLogResult,
} from "../../../infra/k8s/pod-log";
import type {
  LogCommandContext,
  LogInspectionFacts,
  LogProbeConfig,
  PreviousContainerLogObservation,
  ServiceLogObservation,
} from "../model";
import { createTraceLineCollector } from "../config";

interface LogCaptureInput {
  service: string;
  pod: string;
  container: string;
  previous?: boolean;
}

interface PreparedLogCapture {
  input: LogCaptureInput;
  events: string[];
  rawFilePath: string;
}

interface LogCaptureResult extends LogCaptureInput {
  capture: PodLogResult;
  events: string[];
  rawFilePath: string;
}

function collectError(result: PodLogResult): string {
  const kind = result.captureStatus === "partial" ? ": partial" : "";
  return `[collect-error${kind}] ${result.command.join(" ")}\n${result.stderr.trim()}`;
}

function failureReason(result: PodLogResult): string {
  return result.stderr.trim().split("\n")[0] || result.reason || `exit=${result.exitCode}`;
}

function prepareCapture(
  ctx: LogCommandContext,
  config: LogProbeConfig,
  input: LogCaptureInput,
): PodLogCapturePlanItem<PreparedLogCapture> {
  const suffix = input.previous ? "-previous" : "";
  const rawFilePath = join(
    ctx.bundle.dir,
    `.capture-${input.service}-${input.pod}-${input.container}${suffix}.log`,
  );
  const collector = createTraceLineCollector(config.traceIds, config.linePattern);
  return {
    target: { input, events: collector.events, rawFilePath },
    request: {
      pod: input.pod,
      container: input.container,
      prefix: true,
      previous: input.previous,
      since: config.since,
      sinceTime: config.sinceTime,
      rawFilePath,
      onLine: collector.push,
    },
    onStart: () => ctx.log(input.previous
      ? `[collect] ${input.service}/${input.pod}/${input.container} previous…`
      : `[collect] ${input.service}/${input.pod}/${input.container}…`),
  };
}

async function captureLogPlan(
  ctx: LogCommandContext,
  config: LogProbeConfig,
  plan: readonly LogCaptureInput[],
): Promise<LogCaptureResult[]> {
  const captures = await runPodLogCapturePlan(
    ctx.access,
    plan.map((input) => prepareCapture(ctx, config, input)),
  );
  return captures.map(({ target, capture }) => ({
    ...target.input,
    capture,
    events: target.events,
    rawFilePath: target.rawFilePath,
  }));
}

function recordPodLog(ctx: LogCommandContext, input: LogCaptureResult): void {
  const { capture, rawFilePath } = input;
  const previousSuffix = input.previous ? "-previous" : "";
  const partial = capture.captureStatus === "partial";
  ctx.bundle.addStep({
    id: `logs-${input.pod}-${input.container}${previousSuffix}`,
    title: input.previous
      ? `${input.pod}/${input.container} 上一次重启前 trace 日志`
      : `${input.pod}/${input.container} trace 日志`,
    risk: "observe",
    status: capture.captureStatus === "partial"
      ? "partial"
      : capture.captureStatus === "unavailable"
        ? input.previous ? "unavailable" : "failed"
        : "ok",
    reason: capture.captureStatus === "complete"
      ? undefined
      : `${partial ? "部分采集" : "采集不可用"}：${failureReason(capture)}`,
    command: capture.command,
    exitCode: capture.exitCode,
    durationMs: capture.durationMs,
    rawFilePath: existsSync(rawFilePath) ? rawFilePath : undefined,
    ext: "log",
  });
}

function targetKey(service: string, pod: string): string {
  return `${service}\u0000${pod}`;
}

function podCaptureStatus(captures: readonly LogCaptureResult[]): PodLogCaptureStatus {
  if (!captures.length) return "unavailable";
  if (captures.every(({ capture }) => capture.captureStatus === "complete")) return "complete";
  if (captures.every(({ capture }) => capture.captureStatus === "unavailable")) return "unavailable";
  return "partial";
}

/**
 * @rule 捕获可以跨 Service 并发完成，但 Evidence 与 Observation 必须按 Service/Pod/Container 计划顺序落盘，保证 raw 编号和报告可复现。
 */
export function makeLogProbe(
  services: readonly string[],
): Probe<ServiceLogObservation, LogInspectionFacts, LogProbeConfig, LogCommandContext> {
  return {
    id: "service-logs",
    evaluate: (facts) => facts.servicePods.status === "collected"
      ? PROBE_RUNNABLE
      : probeUnavailable(facts.servicePods.reason),
    run: async (ctx, facts, config) => {
      const servicePods = facts.servicePods;
      if (servicePods.status !== "collected") return [];
      const plan = services.flatMap((service) => (
        (servicePods.byService[service] ?? []).flatMap((pod): LogCaptureInput[] => [
          ...(servicePods.containersByPod[pod] ?? []).map((container) => ({
            service,
            pod,
            container,
          })),
          ...(servicePods.previousContainersByPod[pod] ?? []).map((container) => ({
            service,
            pod,
            container,
            previous: true,
          })),
        ])
      ));
      const captures = await captureLogPlan(ctx, config, plan);
      const currentByTarget = new Map<string, LogCaptureResult[]>();
      const previousByTarget = new Map<string, PreviousContainerLogObservation[]>();
      for (const captured of captures) {
        recordPodLog(ctx, captured);
        const key = targetKey(captured.service, captured.pod);
        if (!captured.previous) {
          const current = currentByTarget.get(key) ?? [];
          current.push(captured);
          currentByTarget.set(key, current);
          continue;
        }
        if (captured.capture.captureStatus === "unavailable" && !captured.events.length) continue;
        const previous = previousByTarget.get(key) ?? [];
        previous.push({ container: captured.container, events: captured.events });
        previousByTarget.set(key, previous);
      }
      return services.map((service) => ({
        id: `service-log:${service}`,
        kind: "service-log" as const,
        schemaVersion: 1,
        producer: { origin: "core" as const, id: "service-logs" },
        service,
        pods: (servicePods.byService[service] ?? []).map((pod) => {
          const key = targetKey(service, pod);
          const current = currentByTarget.get(key) ?? [];
          const captureStatus = podCaptureStatus(current);
          const events = current.flatMap(({ capture, events }) => capture.captureStatus === "complete"
            ? events
            : [collectError(capture), ...events]);
          if (!current.length) {
            events.push(`[collect-error] Pod ${pod} 没有可读取的 application container`);
          }
          return {
            pod,
            captureStatus,
            events,
            previous: previousByTarget.get(key) ?? [],
          };
        }),
      }));
    },
  };
}
