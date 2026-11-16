import { expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { createServiceCatalog, withSummary, healthCheckScope, type HealthCheckExtension,
  type HealthProbeExtension, type HealthScope, type ServiceDefinition } from "@compforge/doctor-plugin";
import { CommandContext, CommandStatus } from "../src/command";
import { healthCommand } from "../src/health";
import { healthProviders } from "../src/health/extensions";
import { runHealthSession } from "../src/health/flow";
import { buildHealthHtml } from "../src/health/report";
import { HealthInteraction } from "../src/health/interaction";
import * as selection from "../src/health/selection";
import * as target from "../src/command/kubernetes-target";

const probe = (id: string, scope: HealthScope = "infra"): HealthProbeExtension => ({
  id, kind: `healthcheck.${scope}`, execution: "probe", description: id, access: {},
  approval: { risk: "observe", target: id, impact: ["Bounded probe"] },
  run: withSummary({ title: id, fields: [] }, async () => ({ status: "passed", summary: id, evidence: { host: id } })),
});
const service = (name: string, checks: HealthCheckExtension[] = []): ServiceDefinition => ({
  name, aliases: [`${name}-alias`], workloads: [], extensions: checks,
  component: { name, repository: { forge: { name: "fixture" }, path: name } },
});
const plugin = (services: ServiceDefinition[]) => ({ id: "fixture", version: "1", services: createServiceCatalog(services) });

test("only explicit HealthChecks are discovered; DataSources, endpoints and old probes do not opt in", () => {
  const defined = plugin([service("a", [probe("db-a")]), { ...service("b"), endpoints: [], dataSources: [{ id: "db", kind: "db", backend: "mysql", source: {} as never }] }]);
  expect(healthProviders(defined).map(provider => provider.name)).toEqual(["a"]);
  expect(healthProviders(defined, ["a-alias", "a"])).toHaveLength(1);
  expect(healthProviders(defined, ["b"])[0]?.unsupported).toBeDefined();
  expect(() => healthProviders(defined, undefined, ["biz"])).toThrow("HealthCheck");
});

test("scope order crosses Services; different database checks remain independent", async () => {
  const defined = plugin([service("a", [probe("agent-a", "biz"), probe("db-a"), probe("ready-a", "self"), probe("model-a", "deps")]),
    service("b", [probe("db-b"), probe("db-b-audit"), probe("ready-b", "self")])]);
  const calls: string[] = [];
  const result = await runHealthSession(healthProviders(defined), {}, { signal: new AbortController().signal,
    stopped: () => false, selectBusinessProviders: async providers => { calls.push("select:biz"); return providers; },
    run: async (provider, check) => { calls.push(`${healthCheckScope(check)}:${provider.name}:${check.id}`); return { status: "passed", summary: check.id }; },
    show: () => {},
  });
  expect(calls).toEqual(["infra:a:db-a", "infra:b:db-b", "infra:b:db-b-audit", "self:a:ready-a", "self:b:ready-b", "deps:a:model-a", "select:biz", "biz:a:agent-a"]);
  expect(result.providers.flatMap(provider => provider.checks).every(check => check.status === "passed")).toBe(true);
});

test("stopping retains earlier evidence and all unstarted declarations without invoking them", async () => {
  let stopped = false;
  const result = await runHealthSession(healthProviders(plugin([service("a", [probe("db"), probe("model", "deps"), probe("agent", "biz")])])), {}, {
    signal: new AbortController().signal, stopped: () => stopped,
    selectBusinessProviders: async () => { throw new Error("must not select biz"); },
    run: async (_provider, check, checkpoint) => {
      if (check.id === "model") { stopped = true; return { status: "not-run", summary: "quit" }; }
      checkpoint({ evidence: { host: "db-a" } }); return { status: "passed", summary: "db connected" };
    }, show: () => {},
  });
  expect(result.providers[0]!.checks.map(check => check.status)).toEqual(["passed", "not-run", "not-run"]);
  expect(result.providers[0]!.checks[0]!.evidence).toEqual({ host: "db-a" });
});

test("biz cancellation preserves completed model checks; one failed check does not erase independent checks", async () => {
  const result = await runHealthSession(healthProviders(plugin([service("a", [probe("db"), probe("model", "deps"), probe("agent", "biz")])])), {}, {
    signal: new AbortController().signal, stopped: () => false, selectBusinessProviders: async () => undefined,
    run: async (_provider, check) => { if (check.id === "db") throw new Error("db unavailable"); return { status: "passed", summary: "model response" }; }, show: () => {},
  });
  expect(result.providers[0]!.checks.map(check => check.status)).toEqual(["unavailable", "passed", "not-run"]);
  expect(buildHealthHtml(result)).toContain("model response");
});

async function runCommand(check: HealthProbeExtension, options: { yes?: boolean; scope?: string } = { yes: true }) {
  const context = new CommandContext({}, undefined, { plugin: plugin([service("a", [check])]) });
  context.ensureEnvironment = async () => {};
  const config = spyOn(target, "resolveKubernetesCommandConfig").mockResolvedValue({ profileName: "fixture",
    kubernetes: { namespace: "ns", namespaceSource: "flag", kubeconfigSource: "flag" } });
  const executor = spyOn(target, "createKubernetesExecutor").mockReturnValue({
    run: async args => ({ ok: true, stdout: "fixture\nhttps://cluster.test", stderr: "", exitCode: 0, command: args, durationMs: 1, timedOut: false }),
    exec: async () => { throw new Error("unexpected Pod operation"); },
  });
  try { return await healthCommand.run(context, options); }
  finally {
    config.mockRestore(); executor.mockRestore(); await context.disposeClients();
    for (const artifact of context.artifacts.list()) rmSync(artifact.path, { recursive: true, force: true });
  }
}

test("a denied write check never initializes Plugin access or runs configuration reads", async () => {
  let calls = 0;
  const check = probe("s3"); check.approval.risk = "disrupt";
  check.run = withSummary({ title: "S3", fields: [] }, async () => { calls++; return { status: "passed", summary: "unexpected" }; });
  const result = await runCommand(check, { scope: "infra" });
  expect(calls).toBe(0); expect(result.status).toBe(CommandStatus.Partial);
  expect(result.output?.providers[0]?.checks[0]?.status).toBe("not-run");
});

test("checkpoints survive a failed probe and oversized output cannot be reported as passed", async () => {
  const check = probe("db");
  check.run = withSummary({ title: "DB", fields: [] }, async (_context, input) => {
    input.checkpoint({ status: "partial", summary: "connection prepared", evidence: { stage: "connect" } });
    throw new Error("query failed");
  });
  const result = await runCommand(check);
  expect(result.output?.providers[0]?.checks[0]).toMatchObject({ status: "unavailable", evidence: { stage: "connect" } });
  check.run = withSummary({ title: "DB", fields: [] }, async () => ({ status: "passed", summary: "ok", evidence: { body: "x".repeat(130 * 1024) } }));
  expect((await runCommand(check)).output?.providers[0]?.checks[0]?.status).toBe("unavailable");
});

test("scope selection precedes environment preparation and defaults to infra/self/deps", async () => {
  expect(await selection.selectHealthScope(undefined, true, async input => {
    expect(input.defaults).toEqual(["infra", "self", "deps"]); return [];
  })).toBeUndefined();
  const selected = spyOn(selection, "selectHealthScope").mockResolvedValue(undefined);
  const context = new CommandContext({}, undefined, { plugin: plugin([service("a", [probe("db")])]) });
  context.ensureEnvironment = async () => { throw new Error("must not prepare environment"); };
  try { expect((await healthCommand.run(context, {})).status).toBe(CommandStatus.Cancelled); }
  finally { selected.mockRestore(); await context.disposeClients(); }
});

test("interactive skip continues; quit never grants later check approval", async () => {
  const context = new CommandContext({}, undefined, { plugin: plugin([]) });
  const answers = ["n", "y", "q"];
  const interaction = new HealthInteraction(context, true, async input => input.match(answers.shift()!));
  const request = { id: "check", risk: "observe" as const, title: "check", target: "fixture", impact: [] };
  try {
    expect((await interaction.approve(request)).approved).toBe(false); expect(interaction.stopped).toBe(false);
    expect((await interaction.approve(request)).approved).toBe(true);
    expect((await interaction.approve(request)).approved).toBe(false); expect(interaction.stopped).toBe(true);
    expect((await interaction.approve(request)).approved).toBe(false);
  } finally { await context.disposeClients(); }
});
