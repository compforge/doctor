import { join } from "node:path";
import { PROBE_RUNNABLE, probeUnavailable, type Probe } from "../../protocol";
import type { ExecResult } from "../../../infra/k8s/executor";
import type {
  LogCommandContext,
  LogInspectionFacts,
  LogProbeConfig,
  PreviousContainerLogObservation,
  ServiceLogObservation,
} from "../model";
import { createTraceLineCollector } from "../config";

const LOG_CAPTURE_CONCURRENCY = 8;

interface LogCaptureInput {
  service: string;
  pod: string;
  container?: string;
  previous?: boolean;
}

interface LogCaptureResult extends LogCaptureInput {
  capture: Awaited<ReturnType<typeof capturePodLog>>;
}

function collectError(result: ExecResult): string {
  const suffix = result.timedOut ? ": timeout, partial output follows" : "";
  return `[collect-error${suffix}] ${result.command.join(" ")}\n${result.stderr.trim()}`;
}

function failureReason(result: ExecResult): string {
  return result.stderr.trim().split("\n")[0] || `exit=${result.exitCode}`;
}

async function capturePodLog(
  ctx: LogCommandContext,
  config: LogProbeConfig,
  input: LogCaptureInput,
): Promise<{ result: ExecResult; events: string[]; rawFilePath: string }> {
  const suffix = input.previous ? `-${input.container}-previous` : "";
  const rawFilePath = join(ctx.bundle.dir, `.capture-${input.service}-${input.pod}${suffix}.log`);
  const collector = createTraceLineCollector(config.traceIds, config.linePattern);
  const result = await ctx.access.collectPodLogs({
    pod: input.pod,
    container: input.container,
    allContainers: !input.container,
    prefix: true,
    previous: input.previous,
    since: config.since,
    sinceTime: config.sinceTime,
    rawFilePath,
    onLine: collector.push,
  });
  return { result, events: collector.events, rawFilePath };
}

async function captureLogPlan(
  ctx: LogCommandContext,
  config: LogProbeConfig,
  plan: readonly LogCaptureInput[],
): Promise<LogCaptureResult[]> {
  const results: Array<LogCaptureResult | undefined> = new Array(plan.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < plan.length) {
      const index = cursor++;
      const input = plan[index]!;
      ctx.log(input.previous
        ? `[collect] ${input.service}/${input.pod}/${input.container} previous…`
        : `[collect] ${input.service}/${input.pod}…`);
      results[index] = { ...input, capture: await capturePodLog(ctx, config, input) };
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(LOG_CAPTURE_CONCURRENCY, plan.length) },
    () => worker(),
  ));
  return results.map((result) => result!);
}

function recordPodLog(
  ctx: LogCommandContext,
  input: {
    pod: string;
    container?: string;
    previous?: boolean;
    capture: Awaited<ReturnType<typeof capturePodLog>>;
  },
): void {
  const { result, rawFilePath } = input.capture;
  const previousSuffix = input.previous ? `-${input.container}-previous` : "";
  ctx.bundle.addStep({
    id: `logs-${input.pod}${previousSuffix}`,
    title: input.previous
      ? `${input.pod}/${input.container} 上一次重启前 trace 日志`
      : `${input.pod} trace 日志`,
    risk: "observe",
    status: result.ok ? "ok" : input.previous ? "unavailable" : "failed",
    reason: result.ok ? undefined : failureReason(result),
    command: result.command,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    // raw/ 保存不限容量的 kubectl 原始 stdout；ID/错误过滤只塑造 Observation。
    rawFilePath,
    ext: "log",
  });
}

function targetKey(service: string, pod: string): string {
  return `${service}\u0000${pod}`;
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
          { service, pod },
          ...(servicePods.previousContainersByPod[pod] ?? []).map((container) => ({
            service,
            pod,
            container,
            previous: true,
          })),
        ])
      ));
      const captures = await captureLogPlan(ctx, config, plan);
      const currentByTarget = new Map<string, LogCaptureResult>();
      const previousByTarget = new Map<string, PreviousContainerLogObservation[]>();
      for (const captured of captures) {
        recordPodLog(ctx, captured);
        const key = targetKey(captured.service, captured.pod);
        if (!captured.previous) {
          currentByTarget.set(key, captured);
          continue;
        }
        if (!captured.capture.result.ok && !captured.capture.events.length) continue;
        const previous = previousByTarget.get(key) ?? [];
        previous.push({ container: captured.container!, events: captured.capture.events });
        previousByTarget.set(key, previous);
      }
      return services.map((service) => ({
        id: `service-log:${service}`,
        kind: "service-log" as const,
        service,
        pods: (servicePods.byService[service] ?? []).map((pod) => {
          const key = targetKey(service, pod);
          const current = currentByTarget.get(key)!;
          // kubectl 超时/失败时 raw 文件仍保留已经到手的 stdout；Observation 同样保留已匹配行。
          return {
            pod,
            failed: !current.capture.result.ok,
            events: current.capture.result.ok
              ? current.capture.events
              : [collectError(current.capture.result), ...current.capture.events],
            previous: previousByTarget.get(key) ?? [],
          };
        }),
      }));
    },
  };
}
