import type {
  KubernetesPodLogAccess,
  PodLogRequest,
  PodLogResult,
} from "./pod-log";

export interface PodLogCapturePolicy {
  concurrency: number;
  maxBytesPerCapture: number;
  maxTotalBytes: number;
}

export const DEFAULT_POD_LOG_CAPTURE_POLICY: PodLogCapturePolicy = {
  // 客户现场单流约 13–26 MiB；8 路会把链路打满并触发原来的 60s timeout。
  concurrency: 3,
  maxBytesPerCapture: 64 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
};

export interface PodLogCapturePlanItem<T> {
  target: T;
  request: PodLogRequest;
  onStart?: () => void;
}

export interface PodLogCapturePlanResult<T> {
  target: T;
  request: PodLogRequest;
  capture: PodLogResult;
}

function budgetUnavailable(request: PodLogRequest): PodLogResult {
  return {
    ok: false,
    exitCode: null,
    stdout: "",
    stderr: "日志采集总字节预算已耗尽",
    durationMs: 0,
    timedOut: false,
    command: ["kubernetes-api", "logs", request.pod, ...(request.container ? ["-c", request.container] : [])],
    captureStatus: "unavailable",
    reason: "total_byte_budget",
    bytesRead: 0,
    attempts: 0,
  };
}

/**
 * Stern 风格的有界 fan-out：并发完成 transport，但结果严格按计划顺序返回。
 * 每个 worker 启动前预留字节预算，结束后归还未使用部分，避免并发竞争突破总上限。
 */
export async function runPodLogCapturePlan<T>(
  access: KubernetesPodLogAccess,
  plan: readonly PodLogCapturePlanItem<T>[],
  policy: PodLogCapturePolicy = DEFAULT_POD_LOG_CAPTURE_POLICY,
): Promise<PodLogCapturePlanResult<T>[]> {
  if (!Number.isInteger(policy.concurrency) || policy.concurrency < 1) {
    throw new Error("Pod Log capture concurrency 必须是正整数");
  }
  if (policy.maxBytesPerCapture < 1 || policy.maxTotalBytes < 1) {
    throw new Error("Pod Log capture 字节预算必须为正数");
  }
  const results: Array<PodLogCapturePlanResult<T> | undefined> = new Array(plan.length);
  let cursor = 0;
  let availableBytes = policy.maxTotalBytes;

  const worker = async () => {
    while (cursor < plan.length) {
      const index = cursor++;
      const item = plan[index]!;
      item.onStart?.();
      const reservedBytes = Math.min(policy.maxBytesPerCapture, availableBytes);
      availableBytes -= reservedBytes;
      if (reservedBytes <= 0) {
        results[index] = {
          target: item.target,
          request: item.request,
          capture: budgetUnavailable(item.request),
        };
        continue;
      }
      const request = { ...item.request, limitBytes: reservedBytes };
      const capture = await access.collectPodLogs(request);
      availableBytes += Math.max(0, reservedBytes - capture.bytesRead);
      results[index] = { target: item.target, request, capture };
    }
  };

  await Promise.all(Array.from(
    { length: Math.min(policy.concurrency, plan.length) },
    () => worker(),
  ));
  return results.map((result) => result!);
}
