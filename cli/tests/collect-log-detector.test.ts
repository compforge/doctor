import { describe, expect, test } from "bun:test";
import {
  buildLogCoverage,
  buildLogEvidence,
  logDetectors,
} from "../src/collect/log/detector";
import type {
  LogInspectionFacts,
  ServiceLogObservation,
} from "../src/collect/log/model";

const collectedFacts: LogInspectionFacts = {
  runtime: { status: "collected", kubectlVersion: "v1.31.0" },
  servicePods: {
    status: "collected",
    byService: { api: ["api-0", "api-1"], worker: [] },
    previousContainersByPod: {},
  },
};

function observation(
  service: string,
  pods: ServiceLogObservation["pods"],
): ServiceLogObservation {
  return { id: `service-log:${service}`, kind: "service-log", service, pods };
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
      runtime: { status: "failed", reason: "kubectl 不可用" },
      servicePods: { status: "unavailable", reason: "kubectl 不可用" },
    };

    expect(buildLogCoverage(buildLogEvidence([], runtimeFailed))).toEqual([{
      goal: "log:runtime",
      status: "insufficient",
      missingEvidence: ["kubectl 不可用"],
    }]);
  });

  test("无运行中 Pod 时按 Service 记录证据缺口", () => {
    const evidence = buildLogEvidence([observation("worker", [])], collectedFacts);

    expect(buildLogCoverage(evidence)).toEqual([{
      goal: "log:service:worker",
      status: "insufficient",
      missingEvidence: ["Service worker 没有可采集日志的运行中 Pod"],
    }]);
  });

  test("按 Pod 区分已取得与失败的日志证据", () => {
    const evidence = buildLogEvidence([
      observation("api", [
        { pod: "api-0", events: ["request complete"], failed: false },
        { pod: "api-1", events: ["[collect-error] timeout"], failed: true },
      ]),
    ], collectedFacts);

    expect(buildLogCoverage(evidence)).toEqual([{
      goal: "log:pod:api:api-0",
      status: "sufficient",
      missingEvidence: [],
    }, {
      goal: "log:pod:api:api-1",
      status: "insufficient",
      missingEvidence: ["Pod api-1 的 current 日志读取失败"],
    }]);
  });
});
