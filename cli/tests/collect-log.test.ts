import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandContext } from "../src/command";
import { EvidenceBundle } from "../src/collect/evidence";
import type {
  LogCommandContext,
  LogInspectionFacts,
  LogProbeConfig,
} from "../src/collect/log/model";
import { makeLogProbe } from "../src/collect/log/probe/service";
import type { ExecResult } from "../src/infra/k8s/executor";
import type { KubernetesPodLogAccess } from "../src/infra/k8s/pod-log";

test("Log Probe 跨 Service 有界并发抓取 Pod，并按计划顺序记录 Evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-log-concurrency-"));
  let active = 0;
  let maxActive = 0;
  const access: KubernetesPodLogAccess = {
    clientVersion: async () => { throw new Error("unexpected clientVersion"); },
    listServicePods: async () => { throw new Error("unexpected listServicePods"); },
    collectPodLogs: async (request): Promise<ExecResult> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Bun.sleep(request.pod === "pod-a" ? 20 : 2);
      request.onLine?.(`[pod/${request.pod}/app] 2026-08-19T01:00:00Z INFO trace-1 ok`);
      writeFileSync(request.rawFilePath!, `${request.pod}\n`, "utf8");
      active -= 1;
      return {
        ok: true,
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 2,
        timedOut: false,
        command: ["kubectl", "logs", request.pod],
      };
    },
  };
  const config: LogProbeConfig = {
    traceIds: ["trace-1"],
    namespace: "default",
    services: ["service-a", "service-b", "service-c", "service-d", "service-e"],
    errorsOnly: false,
    outputDir: root,
  };
  const bundle = new EvidenceBundle(root);
  const context = {
    command: new CommandContext({}),
    config,
    access,
    bundle,
    log: () => undefined,
  } satisfies LogCommandContext;
  const facts: LogInspectionFacts = {
    runtime: { status: "collected" },
    servicePods: {
      status: "collected",
      byService: {
        "service-a": ["pod-a"],
        "service-b": ["pod-b"],
        "service-c": ["pod-c"],
        "service-d": ["pod-d"],
        "service-e": ["pod-e"],
      },
      previousContainersByPod: {
        "pod-a": ["app"],
        "pod-b": ["app"],
        "pod-c": ["app"],
        "pod-d": ["app"],
        "pod-e": ["app"],
      },
    },
  };

  try {
    const probe = makeLogProbe(config.services);
    const observations = await probe.run(context, facts, config, []);

    expect(maxActive).toBe(8);
    expect(observations.map((observation) => observation.service)).toEqual([
      "service-a",
      "service-b",
      "service-c",
      "service-d",
      "service-e",
    ]);
    expect(bundle.getSteps().map((step) => step.id)).toEqual([
      "logs-pod-a",
      "logs-pod-a-app-previous",
      "logs-pod-b",
      "logs-pod-b-app-previous",
      "logs-pod-c",
      "logs-pod-c-app-previous",
      "logs-pod-d",
      "logs-pod-d-app-previous",
      "logs-pod-e",
      "logs-pod-e-app-previous",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
