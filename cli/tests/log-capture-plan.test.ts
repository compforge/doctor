import { expect, test } from "bun:test";
import { runPodLogCapturePlan } from "../src/infra/k8s/log-capture-plan";
import type { KubernetesPodLogAccess } from "../src/infra/k8s/pod-log";

test("Pod Log plan 为并发任务预留总预算，耗尽后返回 unavailable", async () => {
  const limits: number[] = [];
  const access: KubernetesPodLogAccess = {
    clientVersion: async () => { throw new Error("unexpected clientVersion"); },
    listServicePods: async () => { throw new Error("unexpected listServicePods"); },
    collectPodLogs: async (request) => {
      limits.push(request.limitBytes!);
      return {
        ok: true,
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 1,
        timedOut: false,
        command: ["kubernetes-api", "logs", request.pod],
        captureStatus: "complete",
        bytesRead: request.limitBytes!,
        attempts: 1,
      };
    },
  };

  const results = await runPodLogCapturePlan(access, ["a", "b", "c"].map((pod) => ({
    target: pod,
    request: { pod, container: "app" },
  })), {
    concurrency: 1,
    maxBytesPerCapture: 10,
    maxTotalBytes: 15,
  });

  expect(limits).toEqual([10, 5]);
  expect(results.map((result) => result.target)).toEqual(["a", "b", "c"]);
  expect(results.map((result) => result.capture.captureStatus)).toEqual([
    "complete",
    "complete",
    "unavailable",
  ]);
  expect(results[2]?.capture.reason).toBe("total_byte_budget");
});
