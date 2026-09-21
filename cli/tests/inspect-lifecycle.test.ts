import { expect, test } from "bun:test";
import {
  deriveDeploymentName,
  matchAutoscalers,
  parseKubernetesAutoscalers,
  parseKubernetesEvents,
  selectLifecycleEvents,
} from "../src/infra/k8s/workload-events";
import { collectedFact, unavailableFact } from "../src/collect/protocol";
import type { InspectDiagnosis } from "../src/collect/inspect/model";
import { buildInspectRuntimeSummary, buildInspectSummary } from "../src/collect/inspect/render";

const EVENTS_JSON = JSON.stringify({
  items: [
    {
      metadata: { name: "e1", namespace: "demo" },
      involvedObject: { kind: "Pod", name: "api-0", namespace: "demo" },
      type: "Warning", reason: "Unhealthy",
      message: 'Liveness probe failed: Get "http://10.0.0.1:8015/health": context deadline exceeded',
      count: 3, firstTimestamp: "2026-09-21T05:08:02Z", lastTimestamp: "2026-09-21T05:08:32Z",
    },
    {
      metadata: { name: "e2", namespace: "demo" },
      involvedObject: { kind: "Pod", name: "api-0", namespace: "demo" },
      type: "Normal", reason: "Killing",
      message: "Container server failed liveness probe, will be restarted",
      count: 1, lastTimestamp: "2026-09-21T05:08:37Z",
    },
    {
      metadata: { name: "e3", namespace: "demo" },
      involvedObject: { kind: "Pod", name: "api-0", namespace: "demo" },
      type: "Normal", reason: "Pulled", message: "Container image already present", count: 2,
      lastTimestamp: "2026-09-21T05:08:38Z",
    },
    {
      metadata: { name: "e4", namespace: "demo" },
      involvedObject: { kind: "Pod", name: "other-0", namespace: "demo" },
      type: "Warning", reason: "BackOff", message: "Back-off restarting failed container",
      count: 5, lastTimestamp: "2026-09-21T05:09:00Z",
    },
    {
      metadata: { name: "e5", namespace: "demo" },
      involvedObject: { kind: "HorizontalPodAutoscaler", name: "api", namespace: "demo" },
      type: "Normal", reason: "SuccessfulRescale",
      message: "New size: 3; reason: cpu resource utilization above target",
      // events.k8s.io 风格：count/lastTimestamp 缺省，走 series
      series: { count: 2, lastObservedTime: "2026-09-21T05:07:47Z" },
    },
  ],
});

const HPA_JSON = JSON.stringify({
  items: [{
    metadata: { name: "api", namespace: "demo" },
    spec: {
      scaleTargetRef: { apiVersion: "apps/v1", kind: "Deployment", name: "api" },
      minReplicas: 2, maxReplicas: 20,
      metrics: [
        { type: "Resource", resource: { name: "cpu", target: { type: "Utilization", averageUtilization: 80 } } },
        { type: "Resource", resource: { name: "memory", target: { type: "Utilization", averageUtilization: 80 } } },
      ],
    },
    status: {
      currentReplicas: 3, desiredReplicas: 3,
      currentMetrics: [
        { type: "Resource", resource: { name: "cpu", current: { averageUtilization: 95 } } },
      ],
    },
  }],
});

test("parseKubernetesEvents 归一 lastTimestamp/eventTime/series 并过滤 namespace", () => {
  const events = parseKubernetesEvents(EVENTS_JSON, "demo");
  expect(events).toHaveLength(5);
  expect(events[0]).toMatchObject({
    type: "Warning", reason: "Unhealthy", objectKind: "Pod", objectName: "api-0",
    count: 3, lastAt: "2026-09-21T05:08:32Z",
  });
  const rescale = events.find((event) => event.reason === "SuccessfulRescale")!;
  expect(rescale.count).toBe(2);
  expect(rescale.lastAt).toBe("2026-09-21T05:07:47Z");
  expect(parseKubernetesEvents(EVENTS_JSON, "other-ns")).toHaveLength(0);
});

test("selectLifecycleEvents 只保留相关对象的 Warning 与生命周期 Normal", () => {
  const events = parseKubernetesEvents(EVENTS_JSON, "demo");
  const selected = selectLifecycleEvents(events, new Set(["api-0", "api"]));
  expect(selected.map((event) => event.reason)).toEqual(["SuccessfulRescale", "Unhealthy", "Killing"]);
});

test("parseKubernetesAutoscalers 解析目标、副本与利用率摘要", () => {
  const [hpa] = parseKubernetesAutoscalers(HPA_JSON, "demo");
  expect(hpa).toMatchObject({
    name: "api", targetKind: "Deployment", targetName: "api",
    minReplicas: 2, maxReplicas: 20, currentReplicas: 3, desiredReplicas: 3,
  });
  expect(hpa!.metrics).toEqual(["cpu: 95%/80%", "memory: ?%/80%"]);
  expect(matchAutoscalers(parseKubernetesAutoscalers(HPA_JSON, "demo"), new Set(["api"]))).toHaveLength(1);
  expect(matchAutoscalers(parseKubernetesAutoscalers(HPA_JSON, "demo"), new Set(["other"]))).toHaveLength(0);
});

test("deriveDeploymentName 只认 Deployment 命名形态", () => {
  expect(deriveDeploymentName("agent-executor-5466ffb4cb-g8wj9")).toBe("agent-executor");
  expect(deriveDeploymentName("api-0")).toBeUndefined();
  expect(deriveDeploymentName("kafka-0")).toBeUndefined();
  expect(deriveDeploymentName("a-b-cdefg")).toBe("a");
  expect(deriveDeploymentName("a-b-CDEFG")).toBeUndefined();
});

function lifecycleDiagnosis(): InspectDiagnosis {
  return {
    findings: [],
    coverage: [{ goal: "workload-runtime", status: "sufficient", missingEvidence: [] }],
    evidence: {
      rows: [],
      observations: [],
      facts: {
        serviceTargets: collectedFact("inspect.service-targets", "service-targets", {
          services: {
            api: {
              service: "api",
              configurationSupported: false,
              workloads: {
                main: {
                  name: "main",
                  location: { kind: "labels", labels: { app: "api" } },
                  probes: [],
                  deployments: [],
                  unavailableDeployments: [],
                  podRuntime: collectedFact("inspect.workload-pods", "service-targets", {
                    pods: [{
                      instance: { platform: "kubernetes", environment: "default", workload: "main", namespace: "demo", pod: "api-0", uid: "uid-0" },
                      pod: "api-0",
                      serviceAccountName: "api",
                      phase: "Running",
                      conditions: [{ type: "Ready", status: "True" }],
                      containers: [{
                        name: "server", image: "example.test/api:v1",
                        requests: {}, limits: {},
                        ready: true, restartCount: 1,
                        state: { kind: "running" },
                        lastTermination: { reason: "Error", exitCode: 143, finishedAt: "2026-09-21T05:08:37Z" },
                      }],
                    }],
                  }),
                },
              },
            },
          },
        }),
        deploymentConfiguration: unavailableFact("inspect.deployment-configuration", "service-targets", "not requested"),
        dependencyTargets: unavailableFact("inspect.dependency-targets", "service-targets", "not requested"),
        lifecycleSignals: collectedFact("inspect.lifecycle-signals", "service-targets", {
          events: selectLifecycleEvents(parseKubernetesEvents(EVENTS_JSON, "demo"), new Set(["api-0", "api"])),
          autoscalers: matchAutoscalers(parseKubernetesAutoscalers(HPA_JSON, "demo"), new Set(["api"])),
        }),
      },
    },
  };
}

test("运行摘要把探针失败事件关联到重启的 Pod，并展示 HPA", () => {
  const summary = buildInspectRuntimeSummary(lifecycleDiagnosis(), "demo");
  expect(summary).toContain("last=terminated: Error, exit=143");
  expect(summary).toContain("关联事件：2026-09-21T05:08:32Z Warning Unhealthy ×3 — Liveness probe failed");
  expect(summary).toContain("关联事件：2026-09-21T05:08:37Z Normal Killing");
  expect(summary).toContain("Autoscaler：");
  expect(summary).toContain("- api → Deployment/api：current=3 desired=3（min=2 max=20；cpu: 95%/80%，memory: ?%/80%）");
  expect(summary).not.toContain("other-0");
});

test("Markdown 摘要包含运行事件与 Autoscaler 表", () => {
  const summary = buildInspectSummary(lifecycleDiagnosis());
  expect(summary).toContain("### 运行事件（关联所选 Workload）");
  expect(summary).toContain("Liveness probe failed");
  expect(summary).toContain("### Autoscaler");
  expect(summary).toContain("| api | Deployment/api | 3 | 3 | 2 | 20 |");
});

test("lifecycle 未采集时摘要显式标注，不冒充健康证据", () => {
  const diagnosis = lifecycleDiagnosis();
  diagnosis.evidence.facts.lifecycleSignals = unavailableFact(
    "inspect.lifecycle-signals", "service-targets", "list events 权限不足",
  );
  const summary = buildInspectRuntimeSummary(diagnosis, "demo");
  expect(summary).toContain("Autoscaler / 事件：未采集（list events 权限不足）");
  expect(summary).not.toContain("关联事件");
  expect(buildInspectSummary(diagnosis)).toContain("_未采集（list events 权限不足）_");
});
