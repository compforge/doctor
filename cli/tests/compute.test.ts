import { expect, test, spyOn } from "bun:test";
import { createServiceCatalog, type ServiceDefinition, type Workload } from "@compforge/doctor-plugin";
import { kubernetesHttpError } from "@compforge/harness-toolbox/errors";
import type { ResourceAccess, Resource } from "@compforge/harness-toolbox/kubernetes/resources";
import { CommandContext, CommandStatus } from "../src/command";
import { computeServices, computeStatus, runCompute, type ComputeResult } from "../src/compute/flow";
import { computeCommand, computeLimits } from "../src/compute";
import { computeTables, computeText, buildComputeHtml } from "../src/compute/report";
import { createDoctorProgram } from "../src/app/main";
import * as execution from "../src/app/command";
import * as output from "../src/terminal/output";
import { deliverSerialized } from "../src/app/delivery";
import * as targets from "../src/command/kubernetes-target";
import { SerializeContext } from "../src/command/serialization/context";
import { RenderContext } from "../src/report/context";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const options = { environment: "fixture", timeoutMs: 1000, maxPods: 10, maxNodes: 10, pageSize: 2 };
const workload = (name = "main", namespace?: string): Workload => ({ name, platform: "kubernetes", namespace,
  location: { kind: "labels", labels: { app: "api" } } });
const service = (name = "api", workloads = [workload()]): ServiceDefinition => ({ name, workloads, aliases: ["short"],
  component: { name, repository: { forge: { name: "fixture" }, path: `fixture/${name}` } } });
const pod = (name = "pod", namespace = "ns"): Resource => ({ metadata: { name, namespace, uid: `${namespace}-${name}`, creationTimestamp: "2026-10-22T00:00:00Z" },
  spec: { nodeName: "node", containers: [{ name: "app", resources: { requests: { cpu: "500m", memory: "1Gi" }, limits: { cpu: "1", memory: "2Gi" } } }] },
  status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] } });
function access(): ResourceAccess {
  return {
    list: async query => {
      if (query.namespace) return { items: [pod("pod", query.namespace)] };
      if (query.apiVersion !== "v1") return { items: [{ metadata: { name: "node" }, usage: { cpu: "1", memory: "2Gi" }, timestamp: "2026-10-23T00:00:00Z", window: "30s" }] };
      if (query.resource === "pods") return { items: [pod()] };
      return { items: [{ metadata: { name: "node", uid: "node-id" }, spec: {}, status: { capacity: { cpu: "8", memory: "16Gi" }, allocatable: { cpu: "7", memory: "15Gi" }, conditions: [] } }] };
    },
    get: async query => query.apiVersion === "v1" ? pod(query.name, query.namespace)
      : { metadata: { name: query.name, namespace: query.namespace }, timestamp: "2026-10-23T00:00:00Z", window: "30s", containers: [{ name: "app", usage: { cpu: "125m", memory: "512Mi" } }] },
  };
}
const run = (api = access(), services = [service()], extra: Partial<Parameters<typeof runCompute>[0]> = {}) =>
  runCompute({ access: api, services, namespace: "ns", options, checkpoint: () => {}, progress: () => {}, ...extra });

test("cluster permission denial preserves Service evidence and is not a health failure", async () => {
  const base = access();
  const result = await run({ ...base, list: query => {
    if (!query.namespace) throw kubernetesHttpError(403);
    return base.list(query);
  } });
  expect(result.cluster?.summary.capacity).toBeUndefined();
  expect(result.services[0]?.compute?.summary.pods?.pods).toBe(1);
  expect(result.services[0]?.compute?.summary.usage?.cpu).toBe(0.125);
  expect(computeStatus(result)).toBe(CommandStatus.Ok);
  expect(computeText(result)).toContain("无权限 (permission_denied, 403)");
  expect(computeTables(result)[0]?.rows[0]).toEqual(["总容量 capacity", "未知", "未知", "不可用"]);
});

test("failed discovery is unknown while a successful empty discovery is zero", async () => {
  const base = access();
  for (const denied of [true, false]) {
    const result = await run({ ...base, list: query => {
      if (!query.namespace) return base.list(query);
      if (denied) throw kubernetesHttpError(403);
      return Promise.resolve({ items: [] });
    } });
    const entry = result.services[0]!;
    expect(entry.compute?.summary.pods?.pods).toBe(denied ? undefined : 0);
    expect(entry.discovery[0]?.issues.length).toBe(denied ? 1 : 0);
    const workloadCell = computeTables(result).find(table => table.title.startsWith("2."))!.rows[0]![1];
    expect(workloadCell).toBe(denied ? "未知 / 1（发现不完整）" : "0 / 1");
    if (denied) expect(computeText(result)).toContain("发现不完整");
  }
});

test("successful Workload discoveries remain a lower bound when sibling discovery fails", async () => {
  const base = access();
  for (const error of [kubernetesHttpError(403), new Error("discovery unavailable")]) {
    const result = await run({ ...base, list: query => {
      if (query.namespace === "denied") throw error;
      return base.list(query);
    } }, [service("api", [workload("known"), workload("unknown", "denied")])]);
    const workloadCell = computeTables(result).find(table => table.title.startsWith("2."))!.rows[0]![1];
    expect(workloadCell).toBe("至少 1 / 2（发现不完整）");
    expect(result.services[0]?.compute?.summary.pods?.pods).toBe(1);
  }
});

test("multiple aliases deduplicate physical Pods within Service but do not sum across Services", async () => {
  const result = await run(access(), [service("api", [workload("a"), workload("b")]), service("worker")]);
  expect(result.services.map(entry => entry.compute?.summary.pods?.pods)).toEqual([1, 1]);
  expect(result.services[0]?.compute?.summary.pods?.requests.cpu).toBe(0.5);
  expect(result.services[0]?.compute?.workloads.map(item => item.workload)).toEqual(["a", "b"]);
  expect(result.cluster?.summary.pods?.pods).toBe(1);
});

test("declared Workload namespace remains explicit and different namespaces are not deduplicated", async () => {
  const result = await run(access(), [service("api", [workload("a"), workload("b", "other")])]);
  expect(result.services[0]?.compute?.summary.pods?.pods).toBe(2);
  expect(result.services[0]?.discovery.map(item => item.namespace)).toEqual(["ns", "other"]);
});

test("bounded pagination retains discovered Pods when a later page is forbidden", async () => {
  const base = access();
  const result = await run({ ...base, list: query => {
    if (!query.namespace) return base.list(query);
    if (query.continue) throw kubernetesHttpError(403);
    return Promise.resolve({ items: [pod()], metadata: { continue: "next" } });
  } });
  expect(result.services[0]?.compute?.summary.pods?.pods).toBe(1);
  expect(result.services[0]?.discovery[0]?.issues[0]?.kind).toBe("permission_denied");
  expect(computeText(result)).toContain("1 / 1（发现不完整）");
  expect(computeTables(result).find(table => table.title.startsWith("2."))!.rows[0]![1]).toBe("1 / 1（发现不完整）");
});

test("discovery limit and repeated pagination tokens remain incomplete", async () => {
  const base = access();
  for (const maxPods of [1, 10]) {
    const result = await run({ ...base, list: query => query.namespace
      ? Promise.resolve({ items: [pod()], metadata: { continue: "same" } }) : base.list(query) }, [service()], { options: { ...options, maxPods } });
    expect(result.services[0]?.discovery[0]?.issues[0]?.kind).toBe(maxPods === 1 ? "limit_exceeded" : "invalid_response");
    expect(computeStatus(result)).toBe(CommandStatus.Partial);
  }
});

test("missing workload metrics remain unknown with requests available", async () => {
  const base = access();
  const result = await run({ ...base, get: query => {
    if (query.apiVersion !== "v1") throw kubernetesHttpError(404);
    return base.get(query);
  } });
  expect(result.services[0]?.compute?.summary.pods?.requests.cpu).toBe(0.5);
  expect(result.services[0]?.compute?.summary.usage).toBeUndefined();
  expect(computeText(result)).toContain("资源或指标不可用");
});

test("unified transport errors are preserved without leaking raw error details", async () => {
  const base = access();
  const result = await run({ ...base, list: query => {
    if (query.namespace) throw new Error("https://user:secret@private.example");
    return base.list(query);
  } });
  expect(JSON.stringify(result)).not.toContain("secret");
  expect(result.services[0]?.discovery[0]?.issues[0]?.kind).toBe("operation_failed");
  expect(computeStatus(result)).toBe(CommandStatus.Partial);
});

test("cancellation stops Service reads and keeps the already collected cluster snapshot", async () => {
  const abort = new AbortController(), reason = new Error("stop");
  let snapshot: ComputeResult | undefined;
  await expect(run(access(), [service()], { options: { ...options, signal: abort.signal }, checkpoint: result => {
    snapshot = result;
    if (result.cluster) abort.abort(reason);
  } })).rejects.toBe(reason);
  expect(snapshot?.cluster?.nodes.items.length).toBe(1);
  expect(snapshot?.services).toEqual([]);
  expect(computeStatus(snapshot!)).toBe(CommandStatus.Cancelled);
});

test("Service selection accepts aliases, deduplicates and rejects unknown names before access", async () => {
  const plugin = { id: "fixture", version: "1", services: createServiceCatalog([service()]) };
  expect(computeServices(plugin, ["api", "short"])).toHaveLength(1);
  expect(computeServices(undefined)).toEqual([]);
  expect(() => computeServices(plugin, ["missing"])).toThrow("未知 Service");
  expect(() => computeLimits({ timeout: "0" })).toThrow("--timeout");
  expect(() => computeLimits({ maxPods: "-1" })).toThrow("--max-pods");
  const context = new CommandContext({}, undefined, { plugin });
  let prepared = false;
  context.ensureEnvironment = async () => { prepared = true; };
  const result = await computeCommand.run(context, { services: ["missing"] });
  expect(result.status).toBe(CommandStatus.Failed);
  expect(prepared).toBe(false);
  await context.disposeClients();
});

test("compute CLI registers selection, global environment and delivery options", async () => {
  const invoke = spyOn(execution, "runCommand").mockResolvedValue(undefined);
  try {
    const program = createDoctorProgram();
    expect(program.commands.find(command => command.name() === "compute")?.helpInformation()).toContain("--max-pods");
    await program.parseAsync(["compute", "-s", "api", "-s", "worker", "-n", "chosen", "-f", "summary", "--max-pods", "5"], { from: "user" });
    expect(invoke.mock.calls[0]?.[0]).toBe(computeCommand);
    expect(invoke.mock.calls[0]?.[2]).toMatchObject({ services: ["api", "worker"], namespace: "chosen", maxPods: "5" });
    expect(invoke.mock.calls[0]?.[1].format).toBe("summary");
  } finally { invoke.mockRestore(); }
});

test("HTML escapes target values and serialized evidence renders without collection access", async () => {
  const result = await run(access(), [service("<script>alert(1)</script>")]);
  expect(buildComputeHtml(result)).not.toContain("<script>");
  expect(buildComputeHtml(result)).toContain("&lt;script&gt;");
  const source = mkdtempSync(join(tmpdir(), "compute-source-")), destination = mkdtempSync(join(tmpdir(), "compute-saved-"));
  try {
    writeFileSync(join(source, "diagnosis.json"), JSON.stringify(result));
    const commandResult = { status: CommandStatus.Ok as const, output: result, artifacts: [{ id: "compute", command: "compute", path: source }] };
    const saved = await SerializeContext.create(destination, computeCommand, commandResult);
    expect(saved.failed).toBe(false);
    rmSync(source, { recursive: true });
    const report = await computeCommand.render!(new RenderContext(saved.artifacts, "fixture"), commandResult);
    expect(report.sections).toHaveLength(1);
    expect(readFileSync(join(destination, "report.html"), "utf8")).toContain("Kubernetes 集群");
    expect(JSON.parse(readFileSync(join(destination, "diagnosis.json"), "utf8")).services).toHaveLength(1);
  } finally { rmSync(source, { recursive: true, force: true }); rmSync(destination, { recursive: true, force: true }); }
});


test("terminal overview stays compact while HTML retains Pod details and tiny usage is not rounded to zero", async () => {
  const result = await run();
  result.services[0]!.compute!.summary.usage = { cpu: 0.000001, memory: 1 };
  expect(computeText(result)).toContain("<0.001 cores");
  expect(computeText(result)).not.toContain("Pod 明细");
  expect(buildComputeHtml(result)).toContain("Pod 明细");
});


for (const cancel of [false, true]) test(`checked command persists partial evidence and shares cancellation (${cancel})`, async () => {
  const context = new CommandContext({}, undefined, { plugin: { id: "fixture", version: "1", services: createServiceCatalog([service()]) } });
  context.ensureEnvironment = async () => {};
  const base = access();
  const api: ResourceAccess = { ...base, list: async query => {
    if (!query.namespace) throw kubernetesHttpError(403);
    if (cancel) { context.cancel(new Error("stop")); context.signal.throwIfAborted(); }
    return base.list(query);
  } };
  const config = spyOn(targets, "resolveKubernetesCommandConfig").mockResolvedValue({ profileName: "fixture", kubernetes: {
    namespace: "ns", namespaceSource: "flag", kubeconfigSource: "flag" } });
  const executor = spyOn(targets, "createKubernetesExecutor").mockReturnValue({
    run: async args => ({ ok: true, stdout: "fixture\nhttps://cluster.example", stderr: "", exitCode: 0, command: args, durationMs: 1, timedOut: false }),
    exec: async () => { throw new Error("unexpected exec"); },
  });
  const clients = spyOn(context.clients, "get").mockResolvedValue({ clusterResources: () => api } as never);
  const stdout = spyOn(output, "writeOutput").mockReturnValue(true);
  const destination = mkdtempSync(join(tmpdir(), "compute-summary-"));
  try {
    const result = await computeCommand.run(context, { services: ["api"] });
    expect(result.status).toBe(cancel ? CommandStatus.Cancelled : CommandStatus.Ok);
    expect(result.artifacts).toHaveLength(1);
    expect(stdout).not.toHaveBeenCalled();
    const serialized = await SerializeContext.create(destination, computeCommand, result);
    expect(serialized.failed).toBe(false);
    expect(await deliverSerialized({ directory: destination, options: { format: "summary" }, code: cancel ? 130 : 0, reportName: "compute" })).toBe(true);
    expect(stdout).toHaveBeenCalledTimes(1);
    expect(String(stdout.mock.calls[0]![0])).toContain("Kubernetes 集群");
    expect(String(stdout.mock.calls[0]![0])).not.toContain("Pod 明细");
    const saved = JSON.parse(readFileSync(join(result.artifacts[0]!.path, "diagnosis.json"), "utf8"));
    expect(saved.complete).toBe(!cancel);
    expect(saved.cluster.nodes.issues[0].kind).toBe("permission_denied");
    if (!cancel) expect(saved.services[0].compute.summary.pods.pods).toBe(1);
  } finally {
    config.mockRestore(); executor.mockRestore(); clients.mockRestore(); stdout.mockRestore();
    rmSync(destination, { recursive: true, force: true });
    await context.disposeClients();
    for (const artifact of context.artifacts.list()) rmSync(artifact.path, { recursive: true, force: true });
  }
});
