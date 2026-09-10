import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandContext } from "../src/command";
import { EvidenceBundle } from "../src/collect/evidence";
import { collectedFact } from "../src/collect/protocol";
import { createTraceLineCollector, validateLogTimeWindow } from "../src/collect/log/config";
import { makeLogProbe } from "../src/collect/log/probe/service";
import { buildLogEvidence, buildLogCoverage } from "../src/collect/log/detector";
import { renderLogResult } from "../src/collect/log/render";
import { writeLogHtmlReport } from "../src/collect/log/html";
import { logTimestampNanos } from "@compforge/harness-toolbox/kubernetes/log-timestamp";
import type { LogInspectionFacts, LogProbeConfig } from "../src/collect/log/model";
import type { KubernetesPodLogAccess, PodLogResult } from "@compforge/harness-toolbox/kubernetes/pod-log";

test("trace discovery precedes content filtering and fires once per ID while retaining multiline errors", () => {
  const hits: string[] = [];
  const collector = createTraceLineCollector(["trace-a", "trace-b"], /ERROR/, (id) => hits.push(id));
  collector.push("2026-09-09T01:00:00Z INFO trace-a found");
  expect(hits).toEqual(["trace-a"]);
  expect(collector.events).toEqual([]);
  collector.push("2026-09-09T01:00:01Z ERROR trace-a trace-b failed");
  collector.push("2026-09-09T01:00:01Z   File \"worker.py\", line 3");
  collector.push("2026-09-09T01:00:01Z ValueError: bad request");
  collector.push("2026-09-09T01:00:02Z INFO unrelated");
  expect(hits).toEqual(["trace-a", "trace-b"]);
  expect(collector.events).toHaveLength(1);
  expect(collector.events[0]).toContain("ValueError: bad request");
});

test("upper bounds require RFC3339, preserve nanos and compare offsets", () => {
  expect(() => validateLogTimeWindow({ untilTime: "yesterday" })).toThrow("RFC3339");
  expect(() => validateLogTimeWindow({ sinceTime: "2026-09-09T01:00:00.000000002Z", untilTime: "2026-09-09T01:00:00.000000001Z" })).toThrow("不能早于");
  expect(() => validateLogTimeWindow({ sinceTime: "2026-09-09T09:00:00+08:00", untilTime: "2026-09-09T01:00:00Z" })).not.toThrow();
  expect(logTimestampNanos("2026-09-09T01:00:00.000000002Z")! - logTimestampNanos("2026-09-09T01:00:00.000000001Z")!).toBe(1n);
});

test("a fast hit is reported while a sibling is blocked; every Pod/current/previous remains searched", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-log-feedback-"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let notify!: () => void;
  const firstHit = new Promise<void>((resolve) => { notify = resolve; });
  const started: string[] = [];
  const messages: string[] = [];
  let completed = false;
  const access: KubernetesPodLogAccess = {
    clientVersion: async () => { throw new Error("unused"); },
    listServicePods: async () => { throw new Error("unused"); },
    collectPodLogs: async (request): Promise<PodLogResult> => {
      started.push(`${request.pod}:${!!request.previous}`);
      expect(request.untilTime).toBe("2026-09-09T02:00:00Z");
      if (request.pod === "slow") await gate;
      const line = `[pod/${request.pod}/app] 2026-09-09T01:00:00Z INFO trace-a found`;
      if (request.pod !== "unmatched") request.onLine?.(line);
      if (request.pod === "unmatched") request.onLine?.(line.replace("trace-a", "unrelated"));
      return { ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 2,
        timedOut: false, command: ["logs", request.pod], captureStatus: "complete", bytesRead: 100, attempts: 1 };
    },
  };
  const config: LogProbeConfig = { bizId: "request",
    traceIds: ["trace-a"], namespace: "test", services: ["api"], errorsOnly: true,
    linePattern: /ERROR/, untilTime: "2026-09-09T02:00:00Z", outputDir: root,
  };
  const facts: LogInspectionFacts = {
    runtime: collectedFact("log.runtime", "log-target", {}),
    servicePods: collectedFact("log.service-pods", "log-target", {
      byService: { api: ["slow", "fast", "unmatched"] }, containersByPod: { slow: ["app"], fast: ["app"], unmatched: ["app"] },
      previousContainersByPod: { slow: [], fast: ["app"] },
    }),
  };
  const command = new CommandContext({});
  try {
    const pending = makeLogProbe(config.services).run({ command, config, access,
      bundle: new EvidenceBundle(root), startedAtMs: Date.now() - 10,
      log: (message) => { messages.push(message); if (message.includes("命中 api/fast")) notify(); },
    }, facts, config, []).then((value) => { completed = true; return value; });
    await firstHit;
    expect(completed).toBeFalse();
    expect(messages.some((line) => line.includes("继续搜索全部 Pod"))).toBeTrue();
    release();
    const observations = await pending;
    expect(started.sort()).toEqual(["fast:false", "fast:true", "slow:false", "unmatched:false"]);
    expect(observations[0]!.pods).toHaveLength(3);
    expect(observations[0]!.capture?.matchedPodCount).toBe(2);
    expect(observations[0]!.capture?.bytesRead).toBe(400);
    const evidence = buildLogEvidence(observations, facts);
    const coverage = buildLogCoverage(evidence);
    expect(coverage.every((item) => item.status === "sufficient")).toBeTrue();
    const rendered = renderLogResult(config, { evidence, coverage, findings: [] });
    expect(rendered.stats.scannedPodCount).toBe(3);
    expect(rendered.stats.matchedEventCount).toBe(0);
    expect(rendered.stats.firstMatchMs).toBeGreaterThanOrEqual(10);
    expect(rendered.summary).toContain("没有日志满足错误/内容筛选");
    writeFileSync(join(root, "timeline.jsonl"), "");
    writeFileSync(join(root, "log-stats.json"), JSON.stringify(rendered.stats));
    writeFileSync(join(root, "manifest.json"), JSON.stringify({ target: { services: ["api"] }, params: { until_time: config.untilTime }, steps: [] }));
    const html = join(root, "report.html");
    writeLogHtmlReport(root, html, "test");
    expect(readFileSync(html, "utf8")).toContain("trace 命中 2 Pod");
    expect(readFileSync(html, "utf8")).toContain("until-time=2026-09-09T02:00:00Z");
  } finally { release(); await command.disposeClients(); rmSync(root, { recursive: true, force: true }); }
});
