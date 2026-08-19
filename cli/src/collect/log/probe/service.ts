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
  input: {
    service: string;
    pod: string;
    container?: string;
    previous?: boolean;
  },
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

export function makeServiceLogProbe(
  service: string,
): Probe<ServiceLogObservation, LogInspectionFacts, LogProbeConfig, LogCommandContext> {
  return {
    id: `service-log-${service}`,
    evaluate: (facts) => facts.servicePods.status === "collected"
      ? PROBE_RUNNABLE
      : probeUnavailable(facts.servicePods.reason),
    run: async (ctx, facts, config) => {
      if (facts.servicePods.status !== "collected") return [];
      const pods = [];
      for (const pod of facts.servicePods.byService[service] ?? []) {
        ctx.log(`[collect] ${service}/${pod}…`);
        const current = await capturePodLog(ctx, config, { service, pod });
        recordPodLog(ctx, { pod, capture: current });

        const previous: PreviousContainerLogObservation[] = [];
        for (const container of facts.servicePods.previousContainersByPod[pod] ?? []) {
          ctx.log(`[collect] ${service}/${pod}/${container} previous…`);
          const capture = await capturePodLog(ctx, config, { service, pod, container, previous: true });
          recordPodLog(ctx, { pod, container, previous: true, capture });
          if (capture.result.ok || capture.events.length) previous.push({ container, events: capture.events });
        }

        // kubectl 超时/失败时 raw 文件仍保留已经到手的 stdout；Observation 同样保留已匹配行。
        pods.push({
          pod,
          failed: !current.result.ok,
          events: current.result.ok ? current.events : [collectError(current.result), ...current.events],
          previous,
        });
      }
      return [{
        id: `service-log:${service}`,
        kind: "service-log",
        service,
        pods,
      }];
    },
  };
}
