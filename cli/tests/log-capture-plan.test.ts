import { ConcurrencyPool } from "@compforge/doctor-toolkit/concurrency";
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


test("cancelling a log plan retains completed captures and drains active work without starting queued pods", async () => {
  const controller = new AbortController();
  const pool = new ConcurrencyPool(1);
  const started: string[] = [];
  let drained = false;
  const access: KubernetesPodLogAccess = {
    clientVersion: async () => { throw new Error("unused"); },
    listServicePods: async () => { throw new Error("unused"); },
    collectPodLogs: async (request) => {
      started.push(request.pod);
      if (request.pod === "b") {
        controller.abort();
        await Bun.sleep(1);
        drained = true;
      }
      return {
        ok: request.pod === "a", exitCode: null, stdout: "partial log", stderr: "",
        durationMs: 1, timedOut: false, command: [],
        captureStatus: request.pod === "a" ? "complete" : "partial", bytesRead: 11, attempts: 1,
      };
    },
  };
  const captures = await runPodLogCapturePlan(access,
    ["a", "b", "c", "d", "e"].map((pod) => ({ target: pod, request: { pod, container: "app" } })),
    { concurrency: 4, maxBytesPerCapture: 100, maxTotalBytes: 1000 }, pool, controller.signal);
  expect(drained).toBeTrue();
  expect(started).toEqual(["a", "b"]);
  expect(captures.map((item) => item.target)).toEqual(["a", "b"]);
  expect(captures.map((item) => item.capture.captureStatus)).toEqual(["complete", "partial"]);
  expect(await pool.run(async () => "released")).toBe("released");
});
