import { infra } from "../../infra";
import type { Executor } from "../../infra/k8s/executor";

export type GdbCapabilityVerification = Awaited<
  ReturnType<typeof infra.target.debugEngine.inspectGdb>
>;

/**
 * 验证 GDB 是否满足诊断能力契约，不 attach 业务进程。
 *
 * 验证会启动 Doctor 自建的短生命周期 Python inferior；它不属于静态 Inspect Facts。
 */
export function verifyGdbCapability(
  executor: Executor,
  pod: string,
  container: string,
): Promise<GdbCapabilityVerification> {
  return infra.target.debugEngine.inspectGdb(executor, pod, container);
}

export function gdbReady(verification: GdbCapabilityVerification): boolean {
  return verification.pythonScripting && verification.inferiorCall;
}
