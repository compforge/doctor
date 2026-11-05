import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExecResult, Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import { CommandContext } from "../src/command";
import { KubernetesAccessContext } from "../src/infra/k8s/access";
import { executorResourceReader } from "../src/infra/k8s/resources";
import { EvidenceBundle } from "../src/collect/evidence";
import { collectedFact, unavailableFact } from "../src/collect/protocol";
import { buildInspectEvidence } from "../src/collect/inspect/detector";
import { detectPodClocks, estimatePodClock } from "../src/collect/inspect/clock";
import { makePodClockProbes, parsePodTime } from "../src/collect/inspect/probe/pod-clock";
import { runCollectInspect } from "../src/collect/inspect";
import { buildInspectHtmlSections, buildInspectSummary } from "../src/collect/inspect/render";
import { examplePlugin } from "../../plugins/example/src";
import { createServiceCatalog } from "@compforge/doctor-plugin";
import type { InspectCommandContext, InspectDiagnosis, InspectFacts, InspectPodRuntimeFact, PodClockObservation } from "../src/collect/inspect/model";

const response = (stdout: string): ExecResult => ({ ok: true, exitCode: 0, stdout, stderr: "", durationMs: 1, timedOut: false, command: ["kubectl", "exec"] });
const pod = (name: string): InspectPodRuntimeFact => ({
  instance: { platform: "kubernetes", environment: "test", workload: "main", namespace: "demo", uid: name, pod: name },
  pod: name, nodeName: "shared-node", environmentContainer: "main", serviceAccountName: "default", phase: "Running", conditions: [],
  containers: [{ name: "main", image: "same-image:v1", requests: {}, limits: {}, restartCount: 0, state: { kind: "running" } }],
});
function facts(pods: InspectPodRuntimeFact[] = []): InspectFacts {
  return {
    serviceTargets: collectedFact("inspect.service-targets", "service-targets", { services: { api: {
      service: "api", workloads: { main: { name: "main", location: { kind: "labels", labels: { app: "api" } },
        probes: [], deployments: [], unavailableDeployments: [], podRuntime: collectedFact("inspect.workload-pods", "service-targets", { pods }) } },
    } } }),
    deploymentConfiguration: unavailableFact("inspect.deployment-configuration", "service-targets", "not requested"),
    dependencyTargets: unavailableFact("inspect.dependency-targets", "service-targets", "not requested"),
    lifecycleSignals: unavailableFact("inspect.lifecycle-signals", "service-targets", "not requested"),
  };
}
function observation(name: string, offsetMs: number, rtt = 20): PodClockObservation {
  return {
    id: `clock-${name}`, kind: "pod-clock", schemaVersion: 1, producer: { origin: "core", id: "pod-clock" },
    service: "api", workload: "main", instance: pod(name).instance, pod: name, nodeName: `node-${name}`, container: "main",
    reference: { id: "batch", host: "doctor-host", wallTimeMs: 1_000_000, monotonicMs: 0 }, status: "collected",
    samples: [{ hostStartMs: 1_000_010, hostEndMs: 1_000_010 + rtt, monotonicStartMs: 10, monotonicEndMs: 10 + rtt,
      stdout: "", podTimeMs: 1_000_010 + rtt / 2 + offsetMs, resolutionMs: 1 }],
  };
}
function evidence(observations: PodClockObservation[]) {
  return buildInspectEvidence(observations, facts(observations.map(item => pod(item.pod))));
}

test("clock parser retains GNU precision and BusyBox second quantization, rejecting malformed output", () => {
  expect(parsePodTime("1700000000.123456789\n")).toEqual({ podTimeMs: 1700000000123.4568, resolutionMs: 1 });
  for (const raw of ["1700000000", "1700000000.%N"]) expect(parsePodTime(raw)).toEqual({ podTimeMs: 1700000000000, resolutionMs: 1000 });
  for (const raw of ["", "1700000000.NaN", "not found", "123\n456"]) expect(() => parsePodTime(raw)).toThrow();
});

test("clock intervals include whole-second truncation and choose the most precise consistent sample", () => {
  const value = observation("one", 0);
  value.samples[0]!.resolutionMs = 1000;
  expect(estimatePodClock(value).estimate).toMatchObject({ lowerMs: -11, upperMs: 1011, offsetMs: 500, uncertaintyMs: 511 });
  value.samples.push(observation("one", 0, 2000).samples[0]!);
  expect(estimatePodClock(value).estimate?.roundTripMs).toBe(20);
  value.samples.push(observation("one", 60_000).samples[0]!);
  expect(estimatePodClock(value).reason).toContain("不相交");
});

test("host bias is not a cross-Pod mismatch; actual spread retains both witnesses", () => {
  const one = observation("one", 120_000), two = observation("two", 120_000);
  let findings = detectPodClocks(evidence([one, two]));
  expect(findings.filter(item => item.kind === "clock.host-offset")).toHaveLength(2);
  expect(findings.some(item => item.kind === "clock.pod-spread")).toBe(false);
  two.samples = observation("two", -60_000).samples;
  findings = detectPodClocks(evidence([one, two]));
  expect(findings.find(item => item.kind === "clock.pod-spread")).toMatchObject({
    minimumOffsetMs: 179777, evidence: [{ observationId: one.id, role: "supporting" }, { observationId: two.id, role: "supporting" }],
  });
});

test("overlapping Workloads cannot turn repeated observations of one Pod into a cross-Pod finding", () => {
  const first = observation("shared", 0), second = observation("shared", 60_000);
  second.id = "clock-shared-other-workload";
  second.workload = "other";
  second.instance = { ...second.instance, workload: "other" };
  const findings = detectPodClocks(evidence([first, second]));
  expect(findings.some(item => item.kind === "clock.pod-spread")).toBe(false);
  expect(findings.find(item => item.kind === "evidence.insufficient")?.message).toContain("同一个 Pod");
});

test("uncertain transport timing, missing samples and a Host jump cannot become clock faults", () => {
  const slow = observation("slow", 6_000, 14_000);
  expect(detectPodClocks(evidence([slow])).map(item => item.kind)).toEqual(["evidence.insufficient"]);
  const one = observation("one", 0), two = observation("two", 120_000);
  two.samples[0]!.hostStartMs += 60_000;
  two.samples[0]!.hostEndMs += 60_000;
  const findings = detectPodClocks(evidence([one, two]));
  expect(findings.map(item => item.kind)).toEqual(["evidence.insufficient"]);
  expect(findings[0]!.message).toContain("Doctor Host");
  expect(detectPodClocks(buildInspectEvidence([], facts([pod("absent")])))[0]!.message).toContain("未采样");
});

for (const mode of ["ok", "denied", "timeout", "missing-date", "malformed", "stopped", "ambiguous", "cancelled"] as const) {
  test(`clock Probe preserves every Pod and bounded execution: ${mode}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "inspect-clock-"));
    const abort = new AbortController();
    const command = new CommandContext({}, undefined, { signal: abort.signal });
    const calls: string[] = [];
    const executor: Executor = {
      run: async () => response("no"),
      exec: async (target, args, options) => {
        calls.push(target.pod);
        expect(args).toEqual(["date", "+%s.%N"]);
        expect(options?.timeoutMs).toBe(5000);
        if (mode === "cancelled") { abort.abort(new Error("cancelled")); throw abort.signal.reason; }
        if (mode === "timeout" || mode === "missing-date") return { ...response(""), ok: false, exitCode: 1, timedOut: mode === "timeout", stderr: "date not found" };
        return response(mode === "malformed" ? "invalid" : String(Date.now() / 1000));
      },
    };
    const authorization = new KubernetesAccessContext(executor);
    const ctx: InspectCommandContext = {
      command, executor, exec: executor.exec, resources: executorResourceReader(executor, "demo"), authorization, bundle: new EvidenceBundle(root), log: () => {},
      config: { namespace: "demo", namespaceSource: "flag", services: ["api"], servicesExplicit: true, format: "bundle", reportName: "clock", profileName: "test", kube: { namespace: "demo" } },
    };
    try {
      if (mode === "denied") await authorization.evaluate({ command: "doctor inspect", namespace: "demo", needs: [{ requirement: "preferred", rule: { verb: "get", resource: "pods/exec" }, purpose: "clock" }] });
      const pods = [pod("one"), pod("two")];
      if (mode === "stopped") pods.forEach(item => { item.phase = "Pending"; });
      if (mode === "ambiguous") pods.forEach(item => { item.environmentContainer = undefined; });
      const input = facts(pods);
      const probes = makePodClockProbes(input);
      expect(probes).toHaveLength(2); // Same node and image still produce separate Pod probes.
      if (mode === "cancelled") {
        await expect(probes[0]!.run(ctx, input, ctx.config, [])).rejects.toThrow("cancelled");
        return;
      }
      const observations = (await Promise.all(probes.map(probe => probe.run(ctx, input, ctx.config, [])))) as PodClockObservation[][];
      const flat = observations.flat();
      expect(flat.map(item => item.pod)).toEqual(["one", "two"]);
      expect(flat.every(item => item.nodeName === "shared-node")).toBe(true);
      expect(new Set(flat.map(item => item.reference.id)).size).toBe(1);
      if (mode === "ok") {
        expect(calls).toHaveLength(6);
        expect(flat.every(item => item.samples.length === 3 && item.status === "collected")).toBe(true);
        const diagnosis = { evidence: buildInspectEvidence(flat, input), findings: [] } as InspectDiagnosis;
        expect(buildInspectSummary(diagnosis)).toContain("偏差 ms（Pod − Host）");
        expect(buildInspectHtmlSections(diagnosis).find(section => section.title.includes("时钟"))?.html).toContain("shared-node");
      } else {
        expect(calls).toHaveLength(["denied", "stopped", "ambiguous"].includes(mode) ? 0 : 2);
        expect(flat.every(item => item.status === "unavailable" && item.reason)).toBe(true);
        expect(detectPodClocks(buildInspectEvidence(flat, input))[0]!.kind).toBe("evidence.insufficient");
      }
    } finally { await command.disposeClients(); rmSync(root, { recursive: true, force: true }); }
  });
}

test("full Inspect discovers Node identities and archives all Pod samples without extra Node access", async () => {
  const root = mkdtempSync(join(tmpdir(), "inspect-clock-integration-"));
  const config = join(root, "config.yaml"); writeFileSync(config, "");
  const plugin = { ...examplePlugin, services: createServiceCatalog([{
    name: "api", component: { name: "api", repository: { forge: { name: "test" }, path: "api" } },
    workloads: [{ name: "main", platform: "kubernetes", container: "main", location: { kind: "labels", labels: { app: "api" } } }],
  }]) };
  const calls: string[][] = [];
  const executor: Executor = {
    run: async args => {
      calls.push([...args]);
      if (args[0] === "config") return response("test\nhttps://cluster.test");
      if (args[0] === "auth") return response("yes");
      if (args[1] === "pods") return response(JSON.stringify({ items: ["one", "two"].map(name => ({
        metadata: { name, namespace: "demo", uid: name, labels: { app: "api" } },
        spec: { nodeName: `node-${name}`, containers: [{ name: "main", image: "api:v1" }] },
        status: { phase: "Running", containerStatuses: [{ name: "main", state: { running: {} } }] },
      })) }));
      if (["events", "horizontalpodautoscalers"].includes(args[1]!)) return response('{"items":[]}');
      throw new Error(`Unexpected request ${args.join(" ")}`);
    },
    exec: async (target) => response(String((Date.now() + (target.pod === "two" ? 60_000 : 0)) / 1000)),
  };
  const context = new CommandContext({}, undefined, { plugin });
  try {
    await runCollectInspect({ namespace: "demo", services: ["api"], deploymentConfig: false, dependencies: false, config, format: "summary" }, plugin, context, executor);
    const path = context.artifacts.list()[0]!.path;
    const diagnosis: InspectDiagnosis = JSON.parse(readFileSync(join(path, "diagnosis.json"), "utf8"));
    const clocks = diagnosis.evidence.observations.filter(item => item.kind === "pod-clock");
    expect(clocks.map(item => item.nodeName)).toEqual(["node-one", "node-two"]);
    expect(clocks.every(item => item.samples.length === 3)).toBe(true);
    expect(diagnosis.findings.some(item => item.kind === "clock.pod-spread")).toBe(true);
    expect(calls.some(args => args[1] === "nodes" || args[1] === "node")).toBe(false);
  } finally {
    await context.disposeClients();
    for (const artifact of context.artifacts.list()) rmSync(dirname(artifact.path), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
