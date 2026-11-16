import { expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { createServiceCatalog, type ServiceDefinition, type ServiceS3DataSource } from "@compforge/doctor-plugin";
import type { Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import { CommandContext, CommandStatus } from "../src/command";
import { healthCommand } from "../src/health";
import { runHealthSession } from "../src/health/flow";
import { healthProviders } from "../src/health/extensions";
import { S3HealthSession } from "../src/health/s3/runtime";
import * as approval from "../src/terminal/approval";
import * as kubernetes from "../src/command/kubernetes-target";

function fixture(outcome: "passed" | "failed" | "skipped" | "unavailable" = "passed", distinct = false) {
  const methods: string[] = []; const keys = new Set<string>();
  let approvals = 0; let preparations = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    methods.push(request.method); keys.add(new URL(request.url).pathname);
    if (request.method === "PUT") { expect(await request.text()).toBe("hello world"); return new Response(null); }
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    return outcome === "failed" ? new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 }) : new Response("hello world");
  } });
  const target = { endpoint: `http://127.0.0.1:${server.port}`, bucket: "shared-bucket", region: "fixture-region",
    credentials: { accessKeyId: "fixture-ak", secretAccessKey: "fixture-secret" }, forcePathStyle: true };
  const source = (id: string, owner = "owner"): ServiceS3DataSource => ({ id, kind: "s3", backend: "s3-compatible",
    source: { clientKey: `${owner}/${id}`, createClient: () => {
      preparations++;
      if (outcome === "unavailable") throw new Error("Fixture configuration unavailable");
      return { target, access: {} as never, initialize: async () => {}, dispose: async () => {} };
    } } });
  const owner: ServiceDefinition = { name: "owner", aliases: ["store"],
    component: { name: "owner", repository: { forge: { name: "test" }, path: "owner" } }, workloads: [],
    dataSources: distinct ? [source("objects"), source("other")] : [source("objects")] };
  const consumer: ServiceDefinition = { ...owner, name: "consumer", aliases: [], dataSources: [], dependencies: [
    { id: "files", service: "store", dataSource: "objects" },
    { id: "same-files", service: "owner", dataSource: "objects" },
  ] };
  const otherOwner: ServiceDefinition = { ...owner, name: "other-owner", aliases: [], dataSources: [source("objects", "other-owner")] };
  const plugin = { id: "fixture", version: "1", services: createServiceCatalog(distinct ? [owner, consumer, otherOwner] : [owner, consumer]) };
  const command = new CommandContext({}, undefined, { plugin, yes: true });
  const executor: Executor = {
    run: async args => {
      if (args[0] !== "config") throw new Error(`Unexpected Kubernetes call: ${args.join(" ")}`);
      return { command: args, ok: true, exitCode: 0, stdout: "fixture\nhttps://kubernetes.test", stderr: "", durationMs: 1, timedOut: false };
    }, exec: async () => { throw new Error("Unexpected Pod access"); },
  };
  const collect: kubernetes.KubernetesCommandConfig = { profileName: "fixture",
    kubernetes: { namespace: "test", namespaceSource: "flag", kubeconfigSource: "flag" } };
  const gate = spyOn(approval, "resolveApprovalGate").mockReturnValue(async () => {
    approvals++; return { approved: outcome !== "skipped", source: "prompt" };
  });
  return { command, plugin, executor, collect, methods, keys, counts: () => ({ approvals, preparations }),
    close: async () => {
      gate.mockRestore(); server.stop(true);
      for (const artifact of command.artifacts.list()) rmSync(artifact.path, { recursive: true, force: true });
      await command.disposeClients();
    } };
}

for (const outcome of ["passed", "failed", "skipped", "unavailable"] as const) {
  test(`Health shares ${outcome} S3 evidence between owner and dependent alias without repeating operations`, async () => {
    const f = fixture(outcome);
    const config = spyOn(kubernetes, "resolveKubernetesCommandConfig").mockResolvedValue(f.collect);
    const executor = spyOn(kubernetes, "createKubernetesExecutor").mockReturnValue(f.executor);
    f.command.ensureEnvironment = async () => {};
    try {
      const result = await healthCommand.run(f.command, { scope: "infra", services: ["owner", "consumer"], yes: true });
      expect(result.status).toBe(outcome === "passed" ? CommandStatus.Ok : outcome === "skipped" ? CommandStatus.Partial : CommandStatus.Failed);
      expect(result.output?.providers.map(provider => provider.name)).toEqual(["owner", "consumer"]);
      const checks = result.output!.providers.map(provider => provider.s3!);
      expect(checks.map(items => items.length)).toEqual([1, 1]);
      expect(checks[0]![0]).toBe(checks[1]![0]);
      expect(checks[0]![0]).toMatchObject({ service: "owner", dataSource: "objects", status: outcome });
      expect(f.counts()).toEqual({ approvals: outcome === "unavailable" ? 0 : 1, preparations: 1 });
      expect(f.methods).toEqual(outcome === "passed" || outcome === "failed" ? ["PUT", "GET", "DELETE"] : []);
      expect(f.keys.size).toBe(outcome === "passed" || outcome === "failed" ? 1 : 0);
    } finally { executor.mockRestore(); config.mockRestore(); await f.close(); }
  });
}

test("concurrent S3 consumers share in-flight cleanup; another session probes again", async () => {
  const f = fixture();
  try {
    const providers = healthProviders(f.plugin);
    providers[1] = { ...providers[1]!, s3Sources: [{ service: "store", dataSource: "objects" }] };
    const session = new S3HealthSession(f.command, f.collect, f.executor);
    const snapshots: string[] = [];
    const [owner, consumer] = await Promise.all(providers.map(provider => session.check(provider,
      checks => snapshots.push(JSON.stringify(checks)))));
    expect(owner![0]).toBe(consumer![0]);
    expect(f.counts().approvals).toBe(1);
    expect(f.methods).toEqual(["PUT", "GET", "DELETE"]);
    expect(snapshots.some(snapshot => snapshot.includes('"operation":"upload","status":"passed"') && snapshot.includes('"operation":"cleanup","status":"not-run"'))).toBe(true);
    const next = await new S3HealthSession(f.command, f.collect, f.executor).check(providers[0]!, () => {});
    expect(next[0]!.key).not.toBe(owner![0]!.key);
    expect(f.counts().approvals).toBe(2);
    expect(f.methods).toEqual(["PUT", "GET", "DELETE", "PUT", "GET", "DELETE"]);
  } finally { await f.close(); }
});

test("different Service/DataSource identities using the same bucket are checked separately", async () => {
  const f = fixture("passed", true);
  try {
    const session = new S3HealthSession(f.command, f.collect, f.executor);
    for (const provider of healthProviders(f.plugin)) await session.check(provider, () => {});
    expect(f.counts()).toEqual({ approvals: 3, preparations: 3 });
    expect(f.methods).toEqual(Array.from({ length: 3 }, () => ["PUT", "GET", "DELETE"]).flat());
    expect(f.keys.size).toBe(3);
  } finally { await f.close(); }
});

test("stopping after an aliased consumer reuses evidence does not add a false not-run check", async () => {
  const f = fixture();
  const controller = new AbortController();
  try {
    const session = new S3HealthSession(f.command, f.collect, f.executor);
    const result = await runHealthSession(healthProviders(f.plugin), {}, {
      scopes: ["infra"], signal: controller.signal, cases: async () => [],
      s3: (provider, checkpoint) => session.check(provider, checkpoint),
      show: current => { if (current.providers[1]?.s3?.length) controller.abort(); },
    });
    expect(result.providers.map(provider => provider.s3?.map(check => check.status))).toEqual([["passed"], ["passed"]]);
    expect(f.methods).toEqual(["PUT", "GET", "DELETE"]);
  } finally { await f.close(); }
});
