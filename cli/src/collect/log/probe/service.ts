import { existsSync } from "node:fs";
import { join } from "node:path";
import { PROBE_RUNNABLE, probeUnavailable, type Probe } from "../../protocol";
import type { PodLogCapturePlanItem } from "@compforge/doctor-toolkit/kubernetes/log-capture-plan";
import { PodLogDataSource } from "@compforge/doctor-toolkit/kubernetes/pod-log-datasource";
import type {
  PodLogCaptureStatus,
  PodLogResult,
} from "@compforge/doctor-toolkit/kubernetes/pod-log";
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
  instance?: string;
}

interface PreparedLogCapture {
  input: LogCaptureInput;
  events: string[];
  rawFilePath: string;
  firstMatchMs?: number;
  startedAfterMs: number;
}

interface LogCaptureResult extends LogCaptureInput {
  capture: PodLogResult;
  events: string[];
  rawFilePath: string;
  firstMatchMs?: number;
  startedAfterMs: number;
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
  startedAtMs: number,
): PodLogCapturePlanItem<PreparedLogCapture> {
  const suffix = input.previous ? "-previous" : "";
  const rawFilePath = join(
    ctx.bundle.dir,
    `.capture-${input.service}-${input.pod}-${input.container}${suffix}.log`,
  );
  const target: PreparedLogCapture = { input, events: [], rawFilePath, startedAfterMs: 0 };
  const collector = createTraceLineCollector(config.traceIds, config.linePattern, (traceId) => {
    const elapsed = Date.now() - startedAtMs;
    target.firstMatchMs ??= elapsed;
    ctx.log(`[collect] 命中 ${input.service}/${input.pod}/${input.container}${suffix}：${traceId}（${elapsed} ms；继续搜索全部 Pod）`);
  });
  target.events = collector.events;
  return {
    target,
    request: {
      pod: input.pod,
      container: input.container,
      prefix: true,
      previous: input.previous,
      since: config.since,
      sinceTime: config.sinceTime,
      untilTime: config.untilTime,
      rawFilePath,
      onLine: collector.push,
    },
    onStart: () => {
      target.startedAfterMs = Date.now() - startedAtMs;
      ctx.log(input.previous
        ? `[collect] ${input.service}/${input.pod}/${input.container} previous…`
        : `[collect] ${input.service}/${input.pod}/${input.container}…`);
    },
  };
}

async function captureLogPlan(
  ctx: LogCommandContext,
  config: LogProbeConfig,
  plan: readonly LogCaptureInput[],
): Promise<LogCaptureResult[]> {
  const startedAtMs = ctx.startedAtMs ?? Date.now();
  // TODO: Evaluate time-window parallelism against single-stream capture. Pod Log API has no
  // server-side end-time filter; compare wall-clock, transferred bytes and coverage before enabling it.
  const sources = await ctx.command.clients.get(new PodLogDataSource({
    kubeconfig: config.kubeconfig, context: config.context, namespace: config.namespace,
  }, ctx.command.limits.podLogs, ctx.command.limits.podLogBytes));
  const results = await Promise.allSettled(plan.map(async input => {
    const { target, request, onStart } = prepareCapture(ctx, config, input, startedAtMs);
    onStart?.();
    const capture = await sources.capture(ctx.access, {
      kubeconfig: config.kubeconfig, context: config.context, namespace: config.namespace, instance: input.instance,
    }, request, () => ctx.log(`[collect] ${input.service}/${input.pod}/${input.container} 复用本轮 raw 日志，独立匹配 trace`));
    return { target, capture };
  }));
  const failure = results.find(result => result.status === "rejected");
  if (failure?.status === "rejected" && !ctx.command.signal.aborted) throw failure.reason;
  // Drain all readers before recording evidence, including active streams completed during cancellation.
  return results.flatMap(result => {
    if (result.status === "rejected" || !result.value.capture) return [];
    const { target, capture } = result.value;
    return [{
      ...target.input,
      capture,
      events: target.events,
      rawFilePath: target.rawFilePath,
      firstMatchMs: target.firstMatchMs,
      startedAfterMs: target.startedAfterMs,
    }];
  });
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
            instance: servicePods.instancesByPod?.[pod]?.[container]?.current,
          })),
          ...(servicePods.previousContainersByPod[pod] ?? []).map((container) => ({
            service,
            pod,
            container,
            previous: true,
            instance: servicePods.instancesByPod?.[pod]?.[container]?.previous,
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
      return services.map((service) => {
        const serviceCaptures = captures.filter((capture) => capture.service === service);
        const matches = serviceCaptures.filter((capture) => capture.firstMatchMs !== undefined);
        return {
          id: `service-log:${service}`,
          kind: "service-log" as const,
          schemaVersion: 1,
          producer: { origin: "core" as const, id: "service-logs" },
          service,
          capture: {
            bytesRead: serviceCaptures.reduce((sum, item) => sum + item.capture.bytesRead, 0),
            reusedCaptureCount: serviceCaptures.filter(item => item.capture.reused).length,
            matchedPodCount: new Set(matches.map((item) => item.pod)).size,
            scannedPodCount: new Set(serviceCaptures.filter((item) => item.capture.attempts > 0).map((item) => item.pod)).size,
            firstMatchMs: matches.length ? Math.min(...matches.map((item) => item.firstMatchMs!)) : undefined,
            wallMs: serviceCaptures.reduce((max, item) => Math.max(max, item.startedAfterMs + item.capture.durationMs), 0),
          },
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
        };
      });
    },
  };
}
