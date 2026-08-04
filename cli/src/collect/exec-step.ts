// 把一次容器内 exec 的结果记进 Worksheet——跨 domain 共用。
//
// 单独成文件而不是并进 evidence.ts：Worksheet 的记账语义（检验项 / 工序 / 三条不变量）
// 跟"证据是怎么来的"无关，evidence.ts 对 kubectl 一无所知是**对的**。这里是两者的胶水，
// 胶水该自己待一层。
import type { EvidenceBundle, StepRisk } from "./evidence";
import type { ExecResult } from "../infra/k8s/executor";
import { failReason } from "../infra/k8s/result";

/**
 * 把 exec 结果填进一个**检验项**。
 *
 * 注意 `status` 只在 ok / failed 之间选——"这份证据拿不到"是 `fillUnavailable` 的事。
 * 两者的区别不是风格：failed 是"我试了、炸了"，unavailable 是"前置不具备、没得试"，
 * 读证据包的人靠这个区分该修环境还是该看错误。
 */
export function fillFromExec(
  bundle: EvidenceBundle,
  id: string,
  res: ExecResult,
  ext = "txt",
) {
  return bundle.fill(id, {
    status: res.ok ? "ok" : "failed",
    reason: res.ok ? undefined : failReason(res),
    command: res.command,
    exitCode: res.exitCode,
    durationMs: res.durationMs,
    output: res.stdout,
    stderr: res.stderr,
    ext,
  });
}

/** 这份证据没拿到。reason 要说清是环境不具备、mode 不允许还是用户拒绝。 */
export function fillUnavailable(bundle: EvidenceBundle, id: string, reason: string) {
  return bundle.fill(id, { status: "unavailable", reason });
}

/** 把 exec 结果记成一条**工序**（0..n 条，不预印）。检验项走 fillFromExec。 */
export function recordExec(
  bundle: EvidenceBundle,
  id: string,
  title: string,
  res: ExecResult,
  ext = "txt",
  risk: StepRisk = "observe",
) {
  return bundle.addStep({
    id,
    title,
    risk,
    status: res.ok ? "ok" : "failed",
    reason: res.ok ? undefined : failReason(res),
    command: res.command,
    exitCode: res.exitCode,
    durationMs: res.durationMs,
    output: res.stdout,
    stderr: res.stderr,
    ext,
  });
}
