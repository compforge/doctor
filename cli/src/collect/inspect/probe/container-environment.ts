import type { ExecResult } from "@compforge/harness-toolbox/kubernetes/executor";
import { currentCommandSignal } from "../../../command/execution-scope";
import type { Probe } from "../../protocol";
import { PROBE_RUNNABLE } from "../../protocol";
import type {
  ContainerEnvironmentObservation, ContainerEnvironmentTarget,
  InspectCommandContext, InspectConfig, InspectFacts, InspectObservation,
} from "../model";

const ENVIRONMENT_TIMEOUT_MS = 15_000;
const MAX_ENVIRONMENT_BYTES = 1024 * 1024;

/** NUL separators preserve multiline values and '=' inside values. Malformed output is a gap. */
export function parseContainerEnvironment(raw: string): Record<string, string> {
  if (Buffer.byteLength(raw, "utf8") > MAX_ENVIRONMENT_BYTES) throw new Error("Pod Env 输出超过 1 MiB 上限");
  if (raw && !raw.endsWith("\0")) throw new Error("Pod Env 输出不是完整的 NUL 分隔数据");
  const entries = raw ? raw.slice(0, -1).split("\0") : [];
  return Object.fromEntries(entries.map(entry => {
    const separator = entry.indexOf("=");
    if (separator <= 0) throw new Error("Pod Env 输出含无效条目");
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
}

export function makeContainerEnvironmentProbe(
  target: ContainerEnvironmentTarget,
): Probe<InspectObservation, InspectFacts, InspectConfig, InspectCommandContext> {
  const id = `container-env-${target.service}-${target.workload}-${target.pod}-${target.container}`;
  return {
    id,
    evaluate: () => PROBE_RUNNABLE,
    run: async ctx => {
      const observation: ContainerEnvironmentObservation = {
        ...target, id, kind: "container-environment", schemaVersion: 1,
        producer: { origin: "core", id: "container-environment" },
        status: "unavailable", values: {},
      };
      let execution: ExecResult | undefined;
      try {
        if (ctx.authorization.fact({ verb: "get", resource: "pods/exec" })?.status === "denied") {
          throw new Error("缺少 pods/exec 权限，无法读取 Pod Env");
        }
        execution = await ctx.exec({ pod: target.pod, container: target.container },
          ["printenv", "-0"], { timeoutMs: ENVIRONMENT_TIMEOUT_MS, signal: currentCommandSignal() });
        if (!execution.ok) throw new Error(execution.timedOut ? "读取 Pod Env 超时（15s）"
          : execution.stderr.trim().split("\n")[0] || `printenv 退出码 ${execution.exitCode}`);
        observation.values = parseContainerEnvironment(execution.stdout);
        observation.status = "collected";
      } catch (error) {
        currentCommandSignal()?.throwIfAborted();
        observation.reason = error instanceof Error ? error.message : String(error);
      }
      ctx.bundle.addStep({
        id, title: `${target.service}/${target.pod}/${target.container} Pod Env`, risk: "observe",
        status: observation.status === "collected" ? "ok" : "unavailable", reason: observation.reason,
        command: execution?.command, durationMs: execution?.durationMs, exitCode: execution?.exitCode,
        output: JSON.stringify(observation, null, 2), ext: "json",
      });
      return [observation];
    },
  };
}
