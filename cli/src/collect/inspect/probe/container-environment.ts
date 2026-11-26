import { redactConfigText } from "./config-value";
import { DoctorError } from "@compforge/doctor-plugin";
import { acquisitionFailure } from "../../../command/diagnostic";
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
    const name = entry.slice(0, separator);
    return [name, redactConfigText(name, entry.slice(separator + 1))];
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
      let failure: ReturnType<typeof acquisitionFailure> | undefined;
      let execution: ExecResult | undefined;
      try {
        if (ctx.authorization.fact({ verb: "get", resource: "pods/exec" }, ctx.config.namespace)?.status === "denied") {
          throw new DoctorError("缺少 pods/exec 权限，无法读取 Pod Env", { code: "forbidden" });
        }
        execution = await ctx.exec({ pod: target.pod, container: target.container },
          ["printenv", "-0"], { timeoutMs: ENVIRONMENT_TIMEOUT_MS, signal: currentCommandSignal() });
        if (!execution.ok) throw new DoctorError(execution.timedOut ? "读取 Pod Env 超时（15s）"
          : execution.stderr.trim().split("\n")[0] || `printenv 退出码 ${execution.exitCode}`, { code: execution.timedOut ? "timeout" : "operation_failed" });
        observation.values = parseContainerEnvironment(execution.stdout);
        observation.status = "collected";
      } catch (error) {
        currentCommandSignal()?.throwIfAborted();
        failure = acquisitionFailure(error);
        observation.reason = failure.reason;
      }
      ctx.bundle.addResult({
        id, title: `${target.service}/${target.pod}/${target.container} Pod Env`, risk: "observe",
        status: observation.status === "collected" ? "ok" : "unavailable", reason: observation.reason,
        reasonCode: failure?.reasonCode, sourceCode: failure?.sourceCode,
        command: execution?.command, durationMs: execution?.durationMs, exitCode: execution?.exitCode,
        output: JSON.stringify(observation, null, 2), ext: "json",
      });
      return [observation];
    },
  };
}
