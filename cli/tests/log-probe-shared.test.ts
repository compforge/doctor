import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parsePods } from "@compforge/harness-toolbox/kubernetes/pod";
import { CommandContext } from "../src/command";
import { EvidenceBundle } from "../src/collect/evidence";
import { makeLogInspect } from "../src/collect/log/fact/inspect";
import { makeLogProbe } from "../src/collect/log/probe/service";
import { buildLogEvidence, buildLogCoverage } from "../src/collect/log/detector";
import type { LogCommandContext, LogProbeConfig, LogInspectionFacts } from "../src/collect/log/model";
import type { KubernetesPodLogAccess } from "@compforge/harness-toolbox/kubernetes/pod-log";

test("two biz-id probes share current/previous sources, retain distinct matching and independently deliver raw evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-log-probe-shared-"));
  const command = new CommandContext({});
  const ok = { ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false, command: [] };
  const pods = parsePods(JSON.stringify({ items: [{
    metadata: { name: "api", uid: "uid-1" },
    spec: { containers: [{ name: "app" }] },
    status: { phase: "Running", containerStatuses: [{ name: "app", containerID: "container-2", restartCount: 1,
      lastState: { terminated: { containerID: "container-1" } } }] },
  }] }), "test");
  const reads: string[] = [];
  const access: KubernetesPodLogAccess = {
    clientVersion: async () => ({ ...ok, stdout: "kubectl test" }),
    listServicePods: async () => ({ serviceCapture: ok, podCapture: ok, byService: { api: ["api"] }, pods }),
    collectPodLogs: async request => {
      reads.push(request.previous ? "previous" : "current");
      request.onLine!("[pod/api/app] 2026-09-10T00:00:01Z ERROR trace-a failed");
      await Bun.sleep(1);
      request.onLine!('[pod/api/app] 2026-09-10T00:00:01Z   File "worker.py", line 3');
      request.onLine!("[pod/api/app] 2026-09-10T00:00:02Z INFO trace-b ok");
      return { ...ok, captureStatus: "complete", bytesRead: 100, attempts: 1 };
    },
  };
  const makeContext = (id: string): LogCommandContext => {
    const path = join(root, id); mkdirSync(path);
    const config: LogProbeConfig = { bizId: "request", namespace: "test", services: ["api"], traceIds: [id], errorsOnly: false,
      sinceTime: "2026-09-10T00:00:00Z", outputDir: path };
    return { command, config, access, bundle: new EvidenceBundle(path), log: () => {} };
  };
  const a = makeContext("trace-a"), b = makeContext("trace-b");
  try {
    const inspected = await makeLogInspect(["api"]).run(a, {});
    const facts: LogInspectionFacts = { runtime: inspected.runtime!, servicePods: inspected.servicePods! };
    expect(facts.servicePods.status).toBe("collected");
    if (facts.servicePods.status !== "collected") throw new Error("expected collected pod identity");
    expect(facts.servicePods.instancesByPod?.api?.app).toEqual({
      current: JSON.stringify(["uid-1", "container-2"]), previous: JSON.stringify(["uid-1", "container-1"]),
    });
    const probe = makeLogProbe(["api"]);
    const [one, two] = await Promise.all([probe.run(a, facts, a.config, []), probe.run(b, facts, b.config, [])]);
    expect(reads.sort()).toEqual(["current", "previous"]);
    expect(one[0]!.pods[0]!.events.join("\n")).toContain('File "worker.py"');
    expect(one[0]!.pods[0]!.events.join("\n")).not.toContain("trace-b");
    expect(two[0]!.pods[0]!.events.join("\n")).toContain("trace-b");
    expect(two[0]!.pods[0]!.events.join("\n")).not.toContain("trace-a");
    expect(one[0]!.capture?.bytesRead).toBe(200);
    expect(two[0]!.capture).toMatchObject({ bytesRead: 0, reusedCaptureCount: 2, matchedPodCount: 1, scannedPodCount: 1 });
    for (const observations of [one, two]) expect(buildLogCoverage(buildLogEvidence(observations, facts)).every(item => item.status === "sufficient")).toBeTrue();
    await command.disposeClients();
    for (const ctx of [a, b]) {
      const raws = ctx.bundle.getSteps().filter(step => step.id.startsWith("logs-"));
      expect(raws).toHaveLength(2);
      for (const step of raws) {
        const raw = readFileSync(join(ctx.bundle.dir, step.raw_file!), "utf8");
        expect(raw).toContain("trace-a"); expect(raw).toContain("trace-b");
      }
    }
  } finally { await command.disposeClients(); rmSync(root, { recursive: true, force: true }); }
});
