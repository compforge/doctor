import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ServiceDefinition, Workload } from "@compforge/doctor-plugin";
import type { Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import type { PodLogRequest, KubernetesPodLogAccess } from "@compforge/harness-toolbox/kubernetes/pod-log";
import { CommandContext, CommandStatus } from "../src/command";
import { EvidenceBundle } from "../src/collect/evidence";
import { collectLog, resolveLogServiceSelection, type LogCollectOptions } from "../src/collect/log";
import { logPlugin, logService } from "./log-fixture";

const ok = { ok: true, exitCode: 0, stderr: "", stdout: "", durationMs: 1, timedOut: false, command: [] };
const labels = (name: string, container?: string): Workload => ({
  name, platform: "kubernetes", location: { kind: "labels", labels: { app: name } }, container,
});
const pod = (name: string, uid = name + "-uid") => ({
  metadata: { name, uid, namespace: "test" },
  spec: { containers: ["app", "sidecar"].map(name => ({ name, env: [{ name: "SECRET", value: "never-export-this" }] })) },
  status: { phase: "Running", containerStatuses: ["app", "sidecar"].map(name => ({
    name, containerID: name + "-current", restartCount: 1, lastState: { terminated: { containerID: name + "-previous" } },
  })) },
});

async function capture(services: ServiceDefinition[], responses: Record<string, unknown>, selection: Pick<LogCollectOptions, "pod" | "container"> | Pick<LogCollectOptions, "pod" | "container">[] = {}) {
  const root = mkdtempSync(join(tmpdir(), "doctor-workload-log-"));
  const command = new CommandContext({}, undefined, { plugin: logPlugin(...services) });
  const calls: string[] = [];
  const reads: PodLogRequest[] = [];
  const executor: Executor = {
    run: async args => {
      const key = args.join(" "); calls.push(key);
      if (args[0] === "config") return { ...ok, stdout: "test\nhttps://cluster.test", command: args };
      if (args[1] === "pods" && args[2] && !args[2].startsWith("-")) {
        const found = Object.values(responses).flatMap(value => (value as { items?: ReturnType<typeof pod>[] }).items ?? [])
          .find(item => item.metadata.name === args[2]);
        if (found) return { ...ok, stdout: JSON.stringify(found), command: args };
      }
      if (!(key in responses)) throw new Error("Unexpected resource access: " + key);
      const value = responses[key];
      if (value instanceof Error) return { ...ok, ok: false, exitCode: 1, stderr: value.message, command: args };
      return { ...ok, stdout: JSON.stringify(value), command: args };
    },
    exec: async () => { throw new Error("Workload lookup must not exec"); },
  };
  const access: KubernetesPodLogAccess = {
    clientVersion: async () => ({ ...ok, stdout: "test" }),
    listServicePods: async () => { throw new Error("Logical Service names are not resource names"); },
    collectPodLogs: async request => {
      reads.push(request);
      request.onLine?.(`[pod/${request.pod}/${request.container}] 2026-09-16T01:00:01Z INFO hello`);
      return { ...ok, captureStatus: "complete", bytesRead: 10, attempts: 1 };
    },
  };
  try {
    const selections = Array.isArray(selection) ? selection : [selection];
    const results = await collectLog(selections.map((selected, index) => ({
      namespace: "test", services: services.map(service => service.name), traceIds: [], errorsOnly: false, ...selected,
      sinceTime: "2026-09-16T01:00:00Z", untilTime: "2026-09-16T02:00:00Z", outputDir: join(root, `item${index}`),
    })), command, executor, () => {}, new EvidenceBundle(join(root, "sources")), access);
    const manifest = JSON.parse(readFileSync(join(root, "sources", "collection.json"), "utf8"));
    const itemManifests = selections.map((_, index) => JSON.parse(readFileSync(join(root, `item${index}`, "collection.json"), "utf8")));
    const itemFacts = itemManifests.map((manifest, index) => JSON.parse(readFileSync(join(root, `item${index}`, manifest.files.facts), "utf8")));
    const itemManifest = itemManifests[0]!;
    const facts = JSON.parse(readFileSync(join(root, "sources", manifest.files.facts), "utf8"));
    return { results, calls, reads, manifest, itemManifest, facts, itemFacts };
  } finally { await command.disposeClients(); rmSync(root, { recursive: true, force: true }); }
}

test("logical Service resolves service/resource/labels Workloads and reads declared containers only", async () => {
  const service: ServiceDefinition = { ...logService("logical-api"), aliases: ["api"], workloads: [
    { name: "front", platform: "kubernetes", container: "app", location: { kind: "service", name: "physical-v2" } },
    { name: "jobs", platform: "kubernetes", container: "app", location: { kind: "resource", resource_kind: "Deployment", name: "jobs-v3" } },
    labels("physical", "app"), // deliberately overlaps the Service location
  ] };
  const result = await capture([service], {
    "get services physical-v2 -o json": { metadata: { name: "physical-v2", namespace: "test" }, spec: { selector: { app: "physical" } } },
    "get pods -l app=physical -o json": { items: [pod("web-1")] },
    "get deployments jobs-v3 -o json": { spec: { selector: { matchLabels: { app: "jobs" } } } },
    "get pods -l app=jobs -o json": { items: [pod("worker-1")] },
  });
  expect(result.results[0]?.status).toBe(CommandStatus.Ok);
  expect(result.reads.map(request => [request.pod, request.container, !!request.previous])).toEqual([
    ["web-1", "app", false], ["web-1", "app", true], ["worker-1", "app", false], ["worker-1", "app", true],
  ]);
  const facts = result.facts.servicePods;
  expect(facts.schemaVersion).toBe(2);
  expect(facts.byService["logical-api"].map((target: { instance: { workload: string } }) => target.instance.workload))
    .toEqual(["front", "jobs", "physical"]);
  expect(facts.byService["logical-api"][0].instance).toMatchObject({
    platform: "kubernetes", namespace: "test", pod: "web-1", uid: "web-1-uid", container: "app",
  });
  expect(JSON.stringify(result.manifest)).not.toContain("never-export-this");
  expect(result.calls.some(call => call.includes("logical-api"))).toBe(false);
});

test("failed and cross-namespace Workloads leave coverage gaps without suppressing other logs", async () => {
  const service = { ...logService(), workloads: [
    labels("ok", "app"), labels("denied"), { ...labels("remote"), namespace: "other" }, labels("empty"),
  ] };
  const result = await capture([service], {
    "get pods -l app=ok -o json": { items: [pod("healthy")] },
    "get pods -l app=denied -o json": new Error("pods forbidden"),
    "get pods -l app=empty -o json": { items: [] },
  });
  expect(result.results[0]?.status).toBe(CommandStatus.Partial);
  expect(result.reads).toHaveLength(2);
  const missing: string[] = result.facts.servicePods.missing.api;
  expect(missing.join("\n")).toContain("api/denied: pods forbidden");
  expect(missing.join("\n")).toContain("--namespace other");
  expect(missing.join("\n")).toContain("api/empty: 没有 Pod");
  expect(result.calls.some(call => call.includes("remote"))).toBe(false);
});

test("no Workload declaration never falls back to a same-name Kubernetes Service", async () => {
  const result = await capture([{ ...logService(), workloads: [] }], {});
  expect(result.results[0]?.status).toBe(CommandStatus.Failed);
  expect(result.calls.filter(call => !call.startsWith("config view "))).toEqual([]);
  expect(result.reads).toEqual([]);
  expect(result.facts.servicePods.missing.api[0]).toContain("未声明");
});

test("overlapping Services retain separate source associations and reuse one bounded raw stream", async () => {
  const shared = labels("shared", "app");
  const result = await capture([
    { ...logService("one"), workloads: [shared] }, { ...logService("two"), workloads: [shared] },
  ], { "get pods -l app=shared -o json": { items: [pod("shared-1")] } });
  expect(result.results[0]?.status).toBe(CommandStatus.Ok);
  expect(result.reads).toHaveLength(2); // one current and one previous, not two per Service
  const steps = result.itemManifest.steps.filter((step: { id: string }) => step.id.startsWith("logs-"));
  expect(steps.map((step: { id: string }) => step.id)).toEqual([
    "logs-one-shared-1-app", "logs-one-shared-1-app-previous", "logs-two-shared-1-app", "logs-two-shared-1-app-previous",
  ]);
});

test("container mismatch is visible instead of broadening to sidecars", async () => {
  const result = await capture([{ ...logService(), workloads: [labels("only", "missing")] }],
    { "get pods -l app=only -o json": { items: [pod("only-1")] } });
  expect(result.results[0]?.status).toBe(CommandStatus.Failed);
  expect(result.reads).toEqual([]);
  expect(result.facts.servicePods.missing.api[0]).toContain("container");
});

test("interactive Service choices come from Catalog without accessing Kubernetes resource names", async () => {
  const plugin = logPlugin({ ...logService("logical"), aliases: ["short"] });
  const executor: Executor = { run: async () => { throw new Error("No cluster discovery"); }, exec: async () => { throw new Error("No exec"); } };
  const selected = await resolveLogServiceSelection({ namespace: "test", catalog: plugin.services, executor, interactive: true,
    prompt: async input => { expect(input.choices.map(choice => choice.name)).toEqual(["logical"]); return ["logical"]; } });
  expect(selected).toEqual(["logical"]);
  expect(await resolveLogServiceSelection({ namespace: "test", catalog: plugin.services, executor, raw: ["short"] })).toEqual(["logical"]);
});

test("Pod replacement during overlapping discovery is a gap, not a misleading source identity", async () => {
  const result = await capture([{ ...logService(), workloads: [labels("first", "app"), labels("second", "app")] }], {
    "get pods -l app=first -o json": { items: [pod("same-name", "old")] },
    "get pods -l app=second -o json": { items: [pod("same-name", "new")] },
  });
  expect(result.results[0]?.status).toBe(CommandStatus.Failed);
  expect(result.reads).toEqual([]);
  expect(result.facts.servicePods.byService.api).toEqual([]);
  expect(result.facts.servicePods.missing.api.join("\n")).toContain("Pod UID");
});

// @case Explicit Pod selection keeps restart evidence without reading neighboring replicas.
test("exact Pod and container selection captures current and previous only for that instance", async () => {
  const result = await capture([{ ...logService(), workloads: [labels("web"), labels("jobs"), labels("app-only", "app")] }], {
    "get pods -l app=web -o json": { items: [pod("web-1"), pod("web-10")] },
    "get pods -l app=jobs -o json": { items: [] },
  }, { pod: "web-1", container: "sidecar" });
  expect(result.results[0]?.status).toBe(CommandStatus.Ok);
  expect(result.reads.map(request => [request.pod, request.container, !!request.previous])).toEqual([
    ["web-1", "sidecar", false], ["web-1", "sidecar", true],
  ]);
  expect(result.itemManifest.target).toMatchObject({ pod: "web-1", container: "sidecar" });
});

test.each([{ pod: "web" }, { container: "absent" }, { pod: "web-1", container: "sidecar" }])(
  "unmatched instance selector %j never broadens the declared Workload", async selection => {
    const result = await capture([{ ...logService(), workloads: [labels("web", "app")] }], {
      "get pods -l app=web -o json": { items: [pod("web-1")] },
    }, selection);
    expect(result.results[0]?.status).toBe(CommandStatus.Failed);
    expect(result.reads).toEqual([]);
    expect(result.results[0]?.missingEvidence?.join("\n")).toContain("没有匹配");
  },
);

test.each(["Failed", "Succeeded"])("%s Pods retain readable container logs", async phase => {
  const terminated = pod("finished");
  terminated.status.phase = phase;
  const result = await capture([{ ...logService(), workloads: [labels("job", "app")] }], {
    "get pods -l app=job -o json": { items: [terminated] },
  });
  expect(result.results[0]?.status).toBe(CommandStatus.Ok);
  expect(result.reads.map(request => [request.pod, !!request.previous])).toEqual([
    ["finished", false], ["finished", true],
  ]);
});

test("shared discovery projects each request's Pod and container independently", async () => {
  const result = await capture([{ ...logService(), workloads: [labels("web")] }], {
    "get pods -l app=web -o json": { items: [pod("web-1"), pod("web-2")] },
  }, [{ pod: "web-1", container: "app" }, { pod: "web-2", container: "sidecar" }]);
  expect(result.results.map(item => item.status)).toEqual([CommandStatus.Ok, CommandStatus.Ok]);
  expect(result.itemFacts.map(facts => facts.servicePods.byService.api.map((target: { instance: { pod: string; container: string } }) =>
    [target.instance.pod, target.instance.container]))).toEqual([[["web-1", "app"]], [["web-2", "sidecar"]]]);
  expect(result.reads.map(request => [request.pod, request.container, !!request.previous])).toEqual([
    ["web-1", "app", false], ["web-1", "app", true], ["web-2", "sidecar", false], ["web-2", "sidecar", true],
  ]);
});
