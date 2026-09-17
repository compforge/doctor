import { logTarget } from "./log-fixture";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
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
import type {
  KubernetesPodLogAccess,
  PodLogResult,
} from "@compforge/harness-toolbox/kubernetes/pod-log";
import { collectedFact } from "../src/collect/protocol";

test("Log Probe 跨 Service 有界并发抓取 Pod，并按计划顺序记录 Evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-log-concurrency-"));
  let active = 0;
  let maxActive = 0;
  const access: KubernetesPodLogAccess = {
    clientVersion: async () => { throw new Error("unexpected clientVersion"); },
    listServicePods: async () => { throw new Error("unexpected listServicePods"); },
    collectPodLogs: async (request): Promise<PodLogResult> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Bun.sleep(request.pod === "pod-a" ? 20 : 2);
      request.onLine?.(`[pod/${request.pod}/app] 2026-08-19T01:00:00Z INFO trace-1 ok`);

      active -= 1;
      return {
        ok: true,
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 2,
        timedOut: false,
        command: ["kubectl", "logs", request.pod],
        captureStatus: "complete",
        bytesRead: request.pod.length + 1,
        attempts: 1,
      };
    },
  };
  const config: LogProbeConfig = { bizId: "request",
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
    runtime: collectedFact("log.runtime", "log-target", {}),
    servicePods: collectedFact("log.service-pods", "log-target", {
      byService: Object.fromEntries(["a", "b", "c", "d", "e"].map(letter =>
        [`service-${letter}`, [logTarget(`pod-${letter}`, true, "default")]])),
      missing: {},
    }),
  };

  try {
    const probe = makeLogProbe(config.services);
    const siblingRoot = mkdtempSync(join(root, "sibling-"));
    const siblingConfig = { ...config, outputDir: siblingRoot };
    const [observations, siblingObservations] = await Promise.all([
      probe.run(context, facts, config, []),
      probe.run({ ...context, config: siblingConfig, bundle: new EvidenceBundle(siblingRoot) }, facts, siblingConfig, []),
    ]);
    expect(siblingObservations).toHaveLength(config.services.length);

    expect(maxActive).toBe(4);
    expect(observations.map((observation) => observation.service)).toEqual([
      "service-a",
      "service-b",
      "service-c",
      "service-d",
      "service-e",
    ]);
    expect(bundle.getSteps().map((step) => step.id)).toEqual([
      "logs-service-a-pod-a-app",
      "logs-service-a-pod-a-app-previous",
      "logs-service-b-pod-b-app",
      "logs-service-b-pod-b-app-previous",
      "logs-service-c-pod-c-app",
      "logs-service-c-pod-c-app-previous",
      "logs-service-d-pod-d-app",
      "logs-service-d-pod-d-app-previous",
      "logs-service-e-pod-e-app",
      "logs-service-e-pod-e-app-previous",
    ]);
  } finally {
    await context.command.disposeClients();
    rmSync(root, { recursive: true, force: true });
  }
});
