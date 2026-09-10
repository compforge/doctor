import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parsePods } from "@compforge/harness-toolbox/kubernetes/pod";
import type { KubernetesPodLogAccess } from "@compforge/harness-toolbox/kubernetes/pod-log";
import { CommandContext, CommandStatus } from "../src/command";
import { EvidenceBundle } from "../src/collect/evidence";
import { collectLog } from "../src/collect/log";

for (const ids of [["trace-a"], ["trace-a", "trace-b"]]) for (const failedPod of [false, true]) {
  test(`Log list ${ids}: one discovery, shared reads and global capacity, failedPod=${failedPod}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "doctor-log-batch-test-"));
    const command = new CommandContext({});
    let versions = 0, discoveries = 0, reads = 0, active = 0, peak = 0;
    const ok = { ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false, command: [] };
    const pods = parsePods(JSON.stringify({ items: Array.from({ length: 6 }, (_, i) => ({
      metadata: { name: `api-${i}`, uid: `uid-${i}` }, spec: { containers: [{ name: "app" }] },
      status: { phase: "Running", containerStatuses: [{ name: "app", containerID: `container-${i}`, restartCount: 0 }] },
    })) }), "test");
    const access: KubernetesPodLogAccess = {
      clientVersion: async () => { versions++; return { ...ok, stdout: "kubectl test" }; },
      listServicePods: async () => { discoveries++; return { serviceCapture: ok, podCapture: ok, byService: { api: pods.map(pod => pod.name) }, pods }; },
      collectPodLogs: async request => {
        reads++; peak = Math.max(peak, ++active);
        await Bun.sleep(3);
        active--;
        if (failedPod && request.pod === "api-5") return { ...ok, ok: false, exitCode: 1, stderr: "pod unavailable", captureStatus: "unavailable", bytesRead: 0, attempts: 1 };
        request.onLine!("[pod/api/app] 2026-09-10T00:00:01Z ERROR trace-a failed");
        request.onLine!("[pod/api/app] 2026-09-10T00:00:02Z INFO trace-b ok");
        return { ...ok, captureStatus: "complete", bytesRead: 100, attempts: 1 };
      },
    };
    const requests = ids.map(id => ({ bizId: id, traceIds: [id], namespace: "test", services: ["api"], errorsOnly: false,
      sinceTime: "2026-09-10T00:00:00Z", outputDir: join(root, id) }));
    try {
      const source = new EvidenceBundle(join(root, "sources"));
      const result = await collectLog(requests, command, { run: async () => { throw new Error("unexpected exec"); }, exec: async () => { throw new Error("unexpected exec"); } },
        () => {}, source, access, 5);
      expect(result.map(item => item.status)).toEqual(ids.map(() => failedPod ? CommandStatus.Partial : CommandStatus.Ok));
      expect(versions).toBe(1); expect(discoveries).toBe(1); expect(reads).toBe(6); expect(peak).toBe(4);
      await command.disposeClients();
      for (const request of requests) {
        const filtered = readFileSync(join(request.outputDir, "service-logs.txt"), "utf8");
        expect(filtered).toContain(request.bizId);
        expect(filtered).not.toContain(request.bizId === "trace-a" ? "trace-b" : "trace-a");
        const manifest = JSON.parse(readFileSync(join(request.outputDir, "manifest.json"), "utf8"));
        expect(manifest.target.biz_id).toBe(request.bizId);
        const raw = manifest.steps.find((step: { raw_file?: string }) => step.raw_file)?.raw_file;
        expect(readFileSync(join(request.outputDir, raw), "utf8")).toContain("trace-a");
        expect(readFileSync(join(request.outputDir, raw), "utf8")).toContain("trace-b");
      }
    } finally { await command.disposeClients(); rmSync(root, { recursive: true, force: true }); }
  });
}
