import type { ExecResult, Executor, RunOptions } from "./executor";
import {
  inspectK8sAccess,
  type K8sAccessRule,
} from "./access";

export type K8sPreflightStatus = "allowed" | "denied" | "unknown" | "not-checked";

export interface K8sCommand {
  args: readonly string[];
  stdin?: string | Uint8Array;
  timeoutMs?: number;
}

/**
 * 一次 K8s mutation 的完整描述。dryRun 与 execute 必须由同一个领域 factory 生成，
 * 这样 Inspect 验证的准入对象才不会和 Probe 真正提交的对象悄悄漂移。
 */
export interface K8sMutation {
  id: string;
  access: K8sAccessRule;
  dryRun: K8sCommand;
  execute: K8sCommand;
}

export interface K8sMutationPreflight {
  authorization: K8sPreflightStatus;
  admission: K8sPreflightStatus;
  runnable: boolean;
  reason?: string;
}

export interface K8sMutationPreflightResult {
  fact: K8sMutationPreflight;
  authorization: ExecResult;
  admission?: ExecResult;
}

function runCommand(exec: Executor, command: K8sCommand): Promise<ExecResult> {
  const options: RunOptions = {
    stdin: command.stdin,
    timeoutMs: command.timeoutMs,
  };
  return exec.run([...command.args], options);
}

/** Inspect 阶段只做 RBAC 与 server-side dry-run，不创建或修改真实资源。 */
export async function inspectK8sMutation(
  exec: Executor,
  mutation: K8sMutation,
): Promise<K8sMutationPreflightResult> {
  const authorization = await inspectK8sAccess(exec, mutation.access);
  if (authorization.status !== "allowed") {
    const reason = authorization.status === "denied"
      ? `RBAC 不允许 ${mutation.access.verb} ${mutation.access.resource}`
      : `无法确认 RBAC 是否允许 ${mutation.access.verb} ${mutation.access.resource}`;
    return {
      fact: {
        authorization: authorization.status,
        admission: "not-checked",
        runnable: false,
        reason,
      },
      authorization: authorization.result,
    };
  }

  const admission = await runCommand(exec, mutation.dryRun);
  return {
    fact: {
      authorization: "allowed",
      admission: admission.ok ? "allowed" : "denied",
      runnable: admission.ok,
      reason: admission.ok
        ? undefined
        : admission.stderr.trim() || admission.stdout.trim() || "server-side dry-run 被拒绝",
    },
    authorization: authorization.result,
    admission,
  };
}

export function executeK8sMutation(
  exec: Executor,
  mutation: K8sMutation,
): Promise<ExecResult> {
  return runCommand(exec, mutation.execute);
}
