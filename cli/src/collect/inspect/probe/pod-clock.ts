import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { ExecResult } from "@compforge/harness-toolbox/kubernetes/executor";
import { currentCommandSignal } from "../../../command/execution-scope";
import { PROBE_RUNNABLE, type Probe } from "../../protocol";
import type {
  InspectCommandContext, InspectConfig, InspectFacts, InspectObservation, InspectPodRuntimeFact,
  PodClockObservation, PodClockReference, PodClockSample,
} from "../model";

const SAMPLE_COUNT = 3;
const SAMPLE_TIMEOUT_MS = 5_000;

/** BusyBox may emit literal %N; retain its one-second quantization rather than inventing precision. */
export function parsePodTime(stdout: string): { podTimeMs: number; resolutionMs: number } {
  const match = /^(\d{1,12})(?:\.(\d{1,9}|%N))?$/.exec(stdout.trim());
  if (!match) throw new Error("date 未返回可解析的 Unix 时间");
  const fraction = match[2];
  const fractional = fraction !== undefined && fraction !== "%N";
  return {
    podTimeMs: Number(match[1]) * 1000 + (fractional ? Number(`0.${fraction}`) * 1000 : 0),
    resolutionMs: fractional ? Math.max(1, 1000 * 10 ** -fraction.length) : 1000,
  };
}

/**
 * @spec Timezone metadata is optional and never changes the Unix timestamp or clock diagnosis.
 * @why %Z can be ambiguous (for example CST); keep the reported abbreviation without inferring an IANA name.
 * @see {@link cli/docs/commands/inspect.md}
 */
export function parsePodClockOutput(stdout: string): ReturnType<typeof parsePodTime> & Pick<PodClockSample, "timezone"> {
  const [epoch = "", offset = "", zone = ""] = stdout.split(/\r?\n/);
  const time = parsePodTime(epoch);
  const utcOffset = /^[+-](?:[01]\d|2[0-3])[0-5]\d$/.test(offset.trim()) ? offset.trim() : undefined;
  const abbreviation = /^[^\s%]{1,64}$/.test(zone.trim()) ? zone.trim() : undefined;
  return { ...time, ...(utcOffset || abbreviation ? { timezone: { utcOffset, abbreviation } } : {}) };
}

/** @spec Probe every discovered Pod in the selected scope; Node and image never deduplicate sampling.
 * @see {@link cli/docs/commands/inspect.md}
 */
export function makePodClockProbes(facts: InspectFacts): Array<Probe<InspectObservation, InspectFacts, InspectConfig, InspectCommandContext>> {
  const reference: PodClockReference = {
    id: randomUUID(), host: hostname(), wallTimeMs: Date.now(), monotonicMs: performance.now(),
  };
  if (facts.serviceTargets.status !== "collected") return [];
  return Object.values(facts.serviceTargets.services).flatMap(service => Object.values(service.workloads)
    .flatMap(workload => workload.podRuntime.status === "collected" ? workload.podRuntime.pods.map(pod =>
      makePodClockProbe(service.service, workload.name, pod, reference)) : []));
}

function makePodClockProbe(service: string, workload: string, pod: InspectPodRuntimeFact, reference: PodClockReference): Probe<InspectObservation, InspectFacts, InspectConfig, InspectCommandContext> {
  const id = `pod-clock-${service}-${workload}-${pod.pod}`;
  return {
    id, evaluate: () => PROBE_RUNNABLE,
    run: async ctx => {
      const observation: PodClockObservation = {
        id, kind: "pod-clock", schemaVersion: 1, producer: { origin: "core", id: "pod-clock" },
        service, workload, instance: pod.instance, pod: pod.pod, container: pod.environmentContainer,
        nodeName: pod.nodeName, reference, status: "unavailable", samples: [],
      };
      const container = pod.containers.find(item => item.name === observation.container);
      const unavailable = !container ? pod.environmentUnavailableReason ?? "无法定位业务 Container"
        : pod.phase !== "Running" || (container.state && container.state.kind !== "running")
          ? `Pod/Container 未运行（${pod.phase}/${container.state?.kind ?? "unknown"}）`
          : ctx.authorization.fact({ verb: "get", resource: "pods/exec" }, ctx.config.namespace)?.status === "denied"
            ? "缺少 pods/exec 权限，无法读取 Pod 时间" : undefined;
      let execution: ExecResult | undefined;
      if (unavailable) observation.reason = unavailable;
      else for (let attempt = 0; attempt < SAMPLE_COUNT; attempt++) {
        const signal = currentCommandSignal() ?? ctx.command.signal;
        signal?.throwIfAborted();
        const hostStartMs = Date.now();
        const monotonicStartMs = performance.now();
        let reason: string | undefined;
        execution = undefined;
        try {
          execution = await ctx.exec({ pod: pod.pod, container: observation.container }, ["date", "+%s.%N%n%z%n%Z"], {
            timeoutMs: SAMPLE_TIMEOUT_MS, signal,
          });
          if (!execution.ok) reason = execution.timedOut ? "读取 Pod 时间超时（5s）"
            : execution.stderr.trim().split("\n")[0] || `date 退出码 ${execution.exitCode}`;
        } catch (error) {
          signal?.throwIfAborted();
          reason = error instanceof Error ? error.message : String(error);
        }
        const hostEndMs = Date.now();
        const monotonicEndMs = performance.now();
        signal?.throwIfAborted();
        const sample = { hostStartMs, hostEndMs, monotonicStartMs, monotonicEndMs, stdout: execution?.stdout ?? "", reason };
        try {
          observation.samples.push(reason ? sample : { ...sample, ...parsePodClockOutput(sample.stdout) });
        } catch (error) {
          sample.reason = error instanceof Error ? error.message : String(error);
          observation.samples.push(sample);
        }
        if (observation.samples.at(-1)?.reason) break;
      }
      observation.status = observation.samples.some(sample => sample.podTimeMs !== undefined) ? "collected" : "unavailable";
      observation.reason ??= observation.samples.find(sample => sample.reason)?.reason;
      ctx.bundle.addStep({
        id, title: `${service}/${pod.pod} Pod 时钟`, risk: "observe",
        status: observation.status === "collected" && !observation.reason ? "ok" : "unavailable", reason: observation.reason,
        command: execution?.command, exitCode: execution?.exitCode,
        durationMs: observation.samples.reduce((total, sample) => total + sample.monotonicEndMs - sample.monotonicStartMs, 0),
        output: JSON.stringify(observation, null, 2), ext: "json",
      });
      return [observation];
    },
  };
}
