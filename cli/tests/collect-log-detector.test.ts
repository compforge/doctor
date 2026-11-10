import { describe, expect, test } from "bun:test";
import {
  detectLogEvidenceGaps,
  buildLogEvidence,
  logDetectors,
} from "../src/collect/log/detector";
import type {
  LogInspectionFacts,
  ServiceLogObservation,
} from "../src/collect/log/model";
import { collectedFact, failedFact, unavailableFact } from "../src/collect/protocol";

const collectedFacts: LogInspectionFacts = {
  runtime: collectedFact("log.runtime", "log-target", { kubectlVersion: "v1.31.0" }),
  servicePods: collectedFact("log.service-pods", "log-target", {
    byService: {}, missing: {},
  }),
};

function observation(
  service: string,
  pods: ServiceLogObservation["pods"],
): ServiceLogObservation {
  return {
    id: `service-log:${service}`,
    kind: "service-log",
    schemaVersion: 1,
    producer: { origin: "core", id: "service-logs" },
    service,
    pods,
  };
}

describe("Log diagnosis", () => {
  test("Evidence 保留冻结 Facts 与 Service Observations", () => {
    const observations = [observation("api", [])];
    const evidence = buildLogEvidence(observations, collectedFacts);

    expect(evidence).toEqual({ observations, facts: collectedFacts });
    expect(logDetectors).toEqual([]);
  });

  test("Inspect 失败形成明确的 insufficient Coverage", () => {
    const runtimeFailed: LogInspectionFacts = {
      runtime: failedFact("log.runtime", "log-target", "kubectl 不可用"),
      servicePods: unavailableFact("log.service-pods", "log-target", "kubectl 不可用"),
    };

    expect(detectLogEvidenceGaps(buildLogEvidence([], runtimeFailed))).toEqual([expect.objectContaining({ kind: "evidence.insufficient", subject: "log:runtime", message: ["kubectl 不可用"].join("；") })]);
  });

  test("无日志 Pod 实例时按 Service 记录证据缺口", () => {
    const evidence = buildLogEvidence([observation("worker", [])], collectedFacts);

    expect(detectLogEvidenceGaps(evidence)).toEqual([expect.objectContaining({ kind: "evidence.insufficient", subject: "log:service:worker", message: ["Service worker 没有可采集日志的 Pod"].join("；") })]);
  });

  test("按 Pod 区分完整、部分与不可用的日志证据", () => {
    const evidence = buildLogEvidence([
      observation("api", [
        { pod: "api-0", events: ["request complete"], captureStatus: "complete" },
        { pod: "api-1", events: ["[collect-error: partial] timeout"], captureStatus: "partial" },
        { pod: "api-2", events: ["[collect-error] denied"], captureStatus: "unavailable" },
      ]),
    ], collectedFacts);

    expect(detectLogEvidenceGaps(evidence)).toEqual([ expect.objectContaining({ kind: "evidence.insufficient", subject: "log:pod:api:api-1", message: ["Pod api-1 只取得部分 current 日志"].join("；") }), expect.objectContaining({ kind: "evidence.insufficient", subject: "log:pod:api:api-2", message: ["Pod api-2 的 current 日志不可用"].join("；") })]);
  });
});

test("discovery gaps cannot turn a wholly unavailable capture into partial success", () => {
  const facts: LogInspectionFacts = {
    ...collectedFacts,
    servicePods: collectedFact("log.service-pods", "log-target", {
      byService: {}, missing: { api: ["another Workload is unavailable"] },
    }),
  };
  const coverage = detectLogEvidenceGaps(buildLogEvidence([observation("api", [
    { pod: "api-0", events: [], captureStatus: "unavailable" },
  ])], facts));
  expect(coverage.map(item => item.kind)).toEqual(["evidence.insufficient", "evidence.insufficient"]);
});
