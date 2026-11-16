import { expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { createServiceCatalog, type ServiceDefinition } from "@compforge/doctor-plugin";
import type { Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import { CommandContext, CommandStatus } from "../src/command";
import { healthCommand } from "../src/health";
import { HealthDatabaseSession } from "../src/health/infra/database";
import { HealthInteraction } from "../src/health/interaction";
import { healthProviders } from "../src/health/extensions";
import { runHealthSession } from "../src/health/flow";
import { buildHealthHtml } from "../src/health/report";
import * as kubernetes from "../src/command/kubernetes-target";

function fixture(outcome: "passed" | "bad-response" | "connection" | "query" | "configuration" | "cancelled" = "passed", answer = "y") {
  let initializes = 0, queries = 0, approvals = 0, disposed = 0;
  const target = { host: "db.fixture", port: 3306, database: "app", user: "private-user", password: "private-secret" };
  const owner: ServiceDefinition = { name: "owner", aliases: ["storage"],
    component: { name: "owner", repository: { forge: { name: "test" }, path: "owner" } }, workloads: [],
    dataSources: [{ id: "db", kind: "db", backend: "mysql", source: { clientKey: "health-test-db", createClient: () => ({
      target, initialize: async () => {
        initializes++;
        if (outcome === "connection") throw Object.assign(new Error("credentials private-secret"), { code: "ER_ACCESS_DENIED_ERROR" });
        if (outcome === "configuration") throw new Error("missing private-secret configuration");
      }, dispose: async () => { disposed++; }, database: { queryReadonly: async (given: typeof target, sql: string, values: unknown[], limits: unknown) => {
        queries++; expect(given).toEqual(target); expect(sql).toBe("SELECT 1 AS doctor_health"); expect(values).toEqual([]);
        expect(limits).toEqual({ timeoutMs: 10_000, maxRows: 1, maxBytes: 1024 });
        if (outcome === "query") throw Object.assign(new Error("query private-secret"), { code: "ETIMEDOUT" });
        if (outcome === "cancelled") command.cancel();
        return { rows: outcome === "bad-response" ? [] : [{ doctor_health: 1 }], columns: ["doctor_health"], bytes: 20, truncated: false };
      } },
    } as never) } }],
  };
  const consumer: ServiceDefinition = { ...owner, name: "consumer", aliases: [], dataSources: [], dependencies: [
    { id: "main", service: "storage", dataSource: "db" }, { id: "duplicate", service: "owner", dataSource: "db" },
  ] };
  const plugin = { id: "fixture", version: "1", services: createServiceCatalog([owner, consumer]) };
  const command = new CommandContext({}, undefined, { plugin });
  const executor: Executor = {
    run: async args => {
      if (args[0] !== "config") throw new Error("Unexpected Kubernetes access");
      return { command: args, ok: true, exitCode: 0, stdout: "fixture\nhttps://kubernetes.test", stderr: "", durationMs: 1, timedOut: false };
    }, exec: async () => { throw new Error("Unexpected Pod query"); },
  };
  const collect: kubernetes.KubernetesCommandConfig = { profileName: "fixture",
    kubernetes: { namespace: "test", namespaceSource: "flag", kubeconfigSource: "flag" } };
  const interaction = new HealthInteraction(command, true, async input => { approvals++; return input.match(answer); });
  return { command, plugin, executor, collect, interaction, counts: () => ({ initializes, queries, approvals, disposed }),
    close: async () => {
      await command.disposeClients();
      for (const artifact of command.artifacts.list()) rmSync(artifact.path, { recursive: true, force: true });
    } };
}

for (const outcome of ["passed", "bad-response", "connection", "query", "configuration", "cancelled"] as const) {
  test(`infra DB preserves ${outcome} evidence without leaking credentials`, async () => {
    const f = fixture(outcome);
    try {
      const session = new HealthDatabaseSession(f.command, f.collect, f.executor, f.interaction);
      const [result] = await session.check(healthProviders(f.plugin)[0]!, () => {});
      expect(result?.status).toBe(outcome === "passed" ? "passed" : outcome === "configuration" ? "unavailable" : outcome === "cancelled" ? "cancelled" : "failed");
      expect(result?.durationMs).toBeGreaterThanOrEqual(0);
      expect(f.counts().queries).toBe(outcome === "connection" || outcome === "configuration" ? 0 : 1);
      const html = buildHealthHtml({ query: {}, providers: [{ name: "owner", namespace: "fixture", databases: [result!] }] });
      expect(html).toContain("infra DB");
      expect(JSON.stringify(result) + html).not.toContain("private-secret");
      expect(JSON.stringify(result) + html).not.toContain("private-user");
      if (outcome === "connection") expect(result?.code).toBe("ER_ACCESS_DENIED_ERROR");
    } finally { await f.close(); }
  });
}

for (const answer of ["y", "n"] as const) test(`shared DB source reuses approval and result, including ${answer}`, async () => {
  const f = fixture("passed", answer);
  try {
    const session = new HealthDatabaseSession(f.command, f.collect, f.executor, f.interaction);
    const results = await Promise.all(healthProviders(f.plugin).map(provider => session.check(provider, () => {})));
    expect(results.map(checks => checks.length)).toEqual([1, 1]);
    expect(results[0]![0]).toBe(results[1]![0]);
    expect(f.counts()).toEqual({ initializes: answer === "y" ? 1 : 0, queries: answer === "y" ? 1 : 0, approvals: 1, disposed: 0 });
    expect(results[0]![0]?.status).toBe(answer === "y" ? "passed" : "skipped");
  } finally { await f.close(); }
});

test("infra-only command discovers DB-only Services and runs no consumer Pod operations", async () => {
  const f = fixture();
  f.command.ensureEnvironment = async () => {};
  const config = spyOn(kubernetes, "resolveKubernetesCommandConfig").mockResolvedValue(f.collect);
  const executor = spyOn(kubernetes, "createKubernetesExecutor").mockReturnValue(f.executor);
  try {
    const result = await healthCommand.run(f.command, { scope: "infra", yes: true });
    expect(result.status).toBe(CommandStatus.Ok);
    expect(result.output?.providers.map(provider => provider.databases?.[0]?.status)).toEqual(["passed", "passed"]);
    expect(f.counts().queries).toBe(1);
  } finally { config.mockRestore(); executor.mockRestore(); await f.close(); }
});

test("quit during infra marks shared DB checks not-run without preparing connections", async () => {
  const f = fixture("passed", "q");
  const session = new HealthDatabaseSession(f.command, f.collect, f.executor, f.interaction);
  try {
    const result = await runHealthSession(healthProviders(f.plugin), {}, { scopes: ["infra"],
      stopped: () => f.interaction.stopped, databases: (provider, checkpoint) => session.check(provider, checkpoint),
      cases: async () => { throw new Error("No biz checks"); }, show: () => {},
    });
    expect(result.providers.map(provider => provider.databases?.[0]?.status)).toEqual(["not-run", "not-run"]);
    expect(f.counts()).toEqual({ initializes: 0, queries: 0, approvals: 1, disposed: 0 });
  } finally { await f.close(); }
});
