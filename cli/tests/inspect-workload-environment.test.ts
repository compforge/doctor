import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExecResult, Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import { createServiceCatalog, type KubernetesWorkloadEnvironmentProbe } from "@compforge/doctor-plugin";
import { CommandContext } from "../src/command";
import { CommandStatus } from "../src/command/status";
import { KubernetesAccessContext } from "../src/infra/k8s/access";
import { executorResourceReader } from "../src/infra/k8s/resources";
import { EvidenceBundle } from "../src/collect/evidence";
import { collectedFact, unavailableFact } from "../src/collect/protocol";
import { buildInspectEvidence, projectInspectServiceEvidence } from "../src/collect/inspect/detector";
import { makeInspectProbes } from "../src/collect/inspect/probe";
import { makeWorkloadEnvironmentProbe } from "../src/collect/inspect/probe/workload-environment";
import { runCollectInspect } from "../src/collect/inspect";
import { buildInspectHtmlSections, buildInspectSummary } from "../src/collect/inspect/render";
import { examplePlugin } from "../../plugins/example/src";
import type { InspectCommandContext, InspectDiagnosis, InspectFacts, InspectPodRuntimeFact, WorkloadEnvironmentObservation } from "../src/collect/inspect/model";

const declaration: KubernetesWorkloadEnvironmentProbe = { id: "environment", kind: "kubernetes.workload-environment", schemaVersion: 1, workload: "main" };
const service = {
  name: "api", component: { name: "api", repository: { forge: { name: "test" }, path: "api" } },
  workloads: [{ name: "main", platform: "kubernetes" as const, container: "main", location: { kind: "labels" as const, labels: { app: "api" } } }],
  environmentProbes: [declaration],
};
const info = { operatingSystem: "linux", osImage: "Kylin Linux Advanced Server V10", kernelVersion: "4.19.90-test", architecture: "amd64" };
const response = (stdout: string): ExecResult => ({ ok: true, exitCode: 0, stdout, stderr: "", durationMs: 1, timedOut: false, command: ["fixture"] });
const pod = (name: string): InspectPodRuntimeFact => ({
  instance: { platform: "kubernetes", environment: "test", workload: "main", namespace: "demo", uid: name, pod: name },
  pod: name, nodeName: `node-${name}`, environmentContainer: "main", serviceAccountName: "default", phase: "Running", conditions: [],
  containers: [{ name: "sidecar", image: "sidecar", requests: {}, limits: {}, restartCount: 0, state: { kind: "running" } },
    { name: "main", image: "api:v1", requests: {}, limits: {}, restartCount: 0, state: { kind: "running" } }],
});
function facts(pods = [pod("b"), pod("a")]): InspectFacts {
  return {
    serviceTargets: collectedFact("inspect.service-targets", "service-targets", { services: { api: {
      service: "api", workloads: { main: { name: "main", location: service.workloads[0]!.location,
        probes: [], deployments: [], unavailableDeployments: [], podRuntime: collectedFact("inspect.workload-pods", "service-targets", { pods }) } },
    } } }),
    deploymentConfiguration: unavailableFact("inspect.deployment-configuration", "service-targets", "not requested"),
    dependencyTargets: unavailableFact("inspect.dependency-targets", "service-targets", "not requested"),
    lifecycleSignals: unavailableFact("inspect.lifecycle-signals", "service-targets", "not requested"),
  };
}

for (const mode of ["amd64", "arm64", "exec-denied", "node-denied", "timeout", "malformed", "missing-field", "missing-node", "both-denied", "cancelled"] as const) {
  test(`workload environment preserves one sampled Pod and independent reads: ${mode}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "inspect-environment-"));
    const abort = new AbortController();
    const command = new CommandContext({}, undefined, { signal: abort.signal });
    const calls: string[][] = [];
    const nodeInfo = { ...info, architecture: mode === "arm64" ? "arm64" : "amd64" };
    if (mode === "missing-field") nodeInfo.osImage = "";
    const executor: Executor = {
      run: async (args, options) => {
        calls.push([...args]);
        if (args[0] === "auth") {
          const denied = mode === "both-denied" || (mode === "exec-denied" && args.includes("pods/exec"))
            || (mode === "node-denied" && args.includes("nodes/node-a"));
          return response(denied ? "no" : "yes");
        }
        expect(args).toEqual(["get", "nodes", "node-a", "-o", "json"]);
        expect(options?.timeoutMs).toBe(5000);
        return response(JSON.stringify({ status: { nodeInfo } }));
      },
      exec: async (target, args, options) => {
        calls.push(["exec", target.pod, target.container!, ...args]);
        expect(target).toEqual({ pod: "a", container: "main" });
        expect(args).toEqual(["cat", "/proc/sys/net/ipv4/ip_forward"]);
        expect(options?.timeoutMs).toBe(5000);
        if (mode === "cancelled") { abort.abort(new Error("cancelled")); throw abort.signal.reason; }
        if (mode === "timeout") return { ...response(""), ok: false, timedOut: true };
        return response(mode === "malformed" ? "unknown" : mode === "arm64" ? "1\n" : "0\n");
      },
    };
    const ctx: InspectCommandContext = {
      command, executor, exec: executor.exec, resources: executorResourceReader(executor, "demo"),
      authorization: new KubernetesAccessContext(executor), bundle: new EvidenceBundle(root), log: () => {},
      config: { namespace: "demo", namespaceSource: "flag", services: ["api"], servicesExplicit: true,
        format: "bundle", reportName: "environment", profileName: "test", kube: { namespace: "demo" } },
    };
    try {
      const pods = [pod("b"), pod("a"), { ...pod("0-pending"), phase: "Pending" }];
      const stopped = pod("0-stopped"); stopped.containers[1]!.state = { kind: "waiting" }; pods.push(stopped);
      if (mode === "missing-node") pods[1]!.nodeName = undefined;
      const input = facts(pods);
      const probe = makeWorkloadEnvironmentProbe("api", declaration);
      if (mode === "cancelled") {
        await expect(probe.run(ctx, input, ctx.config, [])).rejects.toThrow("cancelled");
        expect(calls.some(args => args[1] === "nodes")).toBe(false);
        return;
      }
      const observations = await probe.run(ctx, input, ctx.config, []) as WorkloadEnvironmentObservation[];
      expect(observations).toHaveLength(1);
      const value = observations[0]!;
      expect(value).toMatchObject({ pod: "a", container: "main", workload: "main", namespace: "demo" });
      expect(calls.filter(args => args[0] === "exec")).toHaveLength(["exec-denied", "both-denied"].includes(mode) ? 0 : 1);
      expect(calls.filter(args => args[0] === "get")).toHaveLength(["node-denied", "both-denied", "missing-node"].includes(mode) ? 0 : 1);
      expect(calls.some(args => args.includes("node-b"))).toBe(false);
      if (mode === "amd64" || mode === "arm64") {
        expect(value).toMatchObject({ status: "ok", podIpForward: mode === "arm64" ? 1 : 0, nodeInfo });
      } else {
        expect(value.status).toBe(mode === "both-denied" ? "unavailable" : "partial");
        expect(value.reason).toBeTruthy();
        if (["exec-denied", "timeout", "malformed"].includes(mode)) { expect(value.podIpForward).toBeUndefined(); expect(value.nodeInfo).toEqual(info); }
        if (["node-denied", "missing-node"].includes(mode)) { expect(value.podIpForward).toBe(0); expect(value.nodeInfo).toEqual({}); }
        if (mode === "missing-field") { expect(value.nodeInfo.osImage).toBeUndefined(); expect(value.nodeInfo.kernelVersion).toBe(info.kernelVersion); }
      }
      const evidence = buildInspectEvidence(observations, input);
      const projected = projectInspectServiceEvidence(evidence, "example", ["api"]).observations[0]!;
      expect(projected).toMatchObject({ kind: value.kind, workload: "main", value: { status: value.status, pod: "a", nodeInfo: value.nodeInfo } });
      const diagnosis = { evidence, findings: [] };
      expect(buildInspectSummary(diagnosis)).toContain("Pod ip_forward");
      expect(buildInspectHtmlSections(diagnosis).find(section => section.title === "Workload / 环境")?.html).toContain(value.status);
      const catalog = createServiceCatalog([service]);
      expect(makeInspectProbes(input, ctx.config, catalog, []).some(item => item.id === probe.id)).toBe(true);
      expect(makeInspectProbes(input, { ...ctx.config, field: "image" }, catalog, []).some(item => item.id === probe.id)).toBe(false);
      expect(makeInspectProbes(input, ctx.config, createServiceCatalog([{ ...service, environmentProbes: undefined }]), []).some(item => item.id === probe.id)).toBe(false);
      expect(probe.evaluate(facts([]), ctx.config, [])).toMatchObject({ status: "unavailable" });
    } finally { await command.disposeClients(); rmSync(root, { recursive: true, force: true }); }
  });
}

test("Inspect archives environment partial results when Node access is denied", async () => {
  const root = mkdtempSync(join(tmpdir(), "inspect-environment-integration-"));
  const config = join(root, "config.yaml"); writeFileSync(config, "");
  const plugin = { ...examplePlugin, services: createServiceCatalog([service]) };
  const executor: Executor = {
    run: async args => {
      if (args[0] === "config") return response("test\nhttps://cluster.test");
      if (args[0] === "auth") return response(args.includes("nodes/node-a") ? "no" : "yes");
      if (args[1] === "pods") return response(JSON.stringify({ items: ["b", "a"].map(name => ({
        metadata: { name, namespace: "demo", uid: name, labels: { app: "api" } },
        spec: { nodeName: `node-${name}`, containers: [{ name: "main", image: "api:v1" }] },
        status: { phase: "Running", containerStatuses: [{ name: "main", state: { running: {} } }] },
      })) }));
      if (["events", "horizontalpodautoscalers"].includes(args[1]!)) return response('{"items":[]}');
      throw new Error(`Unexpected request ${args.join(" ")}`);
    },
    exec: async (_target, args) => response(args[0] === "cat" ? "0\n" : `${Date.now() / 1000}\n+0000\nUTC\n`),
  };
  const context = new CommandContext({}, undefined, { plugin });
  try {
    const result = await runCollectInspect({ namespace: "demo", services: ["api"], deploymentConfig: false, dependencies: false, config, format: "summary" }, plugin, context, executor);
    expect(result.status).toBe(CommandStatus.Partial);
    const path = context.artifacts.list()[0]!.path;
    const diagnosis: InspectDiagnosis = JSON.parse(readFileSync(join(path, "diagnosis.json"), "utf8"));
    const observations = diagnosis.evidence.observations.filter(item => item.kind === "kubernetes-workload-environment");
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ pod: "a", nodeName: "node-a", podIpForward: 0, nodeInfo: {}, status: "partial" });
  } finally {
    await context.disposeClients();
    for (const artifact of context.artifacts.list()) rmSync(dirname(artifact.path), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
