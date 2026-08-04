import type { ExecResult, ExecTarget, Executor } from "../../k8s/executor";
import type {
  NetworkCaptureMetadata,
  NetworkCaptureResult,
  NetworkCaptureRuntime,
  StartNetworkCaptureOptions,
} from "./model";

const CONTROLLER = "/opt/doctor/bin/net-capture";

function resultReason(result: ExecResult): string {
  return result.stderr.trim().split("\n")[0] || `exit=${result.exitCode ?? "unknown"}`;
}

function parseMetadata(result: ExecResult): NetworkCaptureResult {
  if (!result.ok) return { result, reason: resultReason(result) };
  const line = result.stdout.trim().split("\n").at(-1);
  if (!line) return { result, reason: "抓包控制器未返回 JSON" };
  try {
    const metadata = JSON.parse(line) as NetworkCaptureMetadata;
    if (!metadata.session_id || !metadata.status) {
      return { result, reason: "抓包控制器返回缺少 session_id/status" };
    }
    return { result, metadata };
  } catch (error) {
    return {
      result,
      reason: `抓包控制器 JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function invoke(
  executor: Executor,
  target: ExecTarget,
  command: string,
  sessionId: string,
  args: string[] = [],
  timeoutMs = 30_000,
): Promise<NetworkCaptureResult> {
  const result = await executor.exec(
    target,
    [CONTROLLER, command, "--session", sessionId, ...args],
    { timeoutMs },
  );
  return parseMetadata(result);
}

export const kubernetesNetworkCaptureRuntime: NetworkCaptureRuntime = {
  inspectReadiness(executor: Executor, target: ExecTarget): Promise<ExecResult> {
    return executor.exec(
      target,
      [
        "sh",
        "-c",
        `test -x ${CONTROLLER} && command -v tcpdump >/dev/null && command -v ip >/dev/null && ${CONTROLLER} --help >/dev/null`,
      ],
      { timeoutMs: 20_000 },
    );
  },

  start(
    executor: Executor,
    target: ExecTarget,
    options: StartNetworkCaptureOptions,
  ): Promise<NetworkCaptureResult> {
    return invoke(executor, target, "start", options.sessionId, [
      "--timeout-seconds",
      String(options.timeoutSeconds),
      "--max-bytes",
      String(options.maxBytes),
      "--filter",
      options.filter,
    ]);
  },

  status(executor: Executor, target: ExecTarget, sessionId: string): Promise<NetworkCaptureResult> {
    return invoke(executor, target, "status", sessionId);
  },

  stop(executor: Executor, target: ExecTarget, sessionId: string): Promise<NetworkCaptureResult> {
    return invoke(executor, target, "stop", sessionId, [], 45_000);
  },

  metadata(executor: Executor, target: ExecTarget, sessionId: string): Promise<NetworkCaptureResult> {
    return invoke(executor, target, "metadata", sessionId, [], 10 * 60_000);
  },

  cleanup(executor: Executor, target: ExecTarget, sessionId: string): Promise<NetworkCaptureResult> {
    return invoke(executor, target, "cleanup", sessionId);
  },
};
