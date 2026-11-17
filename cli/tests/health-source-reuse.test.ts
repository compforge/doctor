import { expect, test } from "bun:test";
import { withSummary, type HealthProbeExtension, type PluginContext } from "@compforge/doctor-plugin";
import type { Client } from "@compforge/harness-common";
import { CommandContext } from "../src/command";
import type { ApprovalRequest } from "../src/command/approval";
import { createHealthProbeRunner } from "../src/health/probe";
import type { HealthProvider } from "../src/health/extensions";
import type { createPluginOperationInvoker } from "../src/plugin/operation-invoker";

function fixture() {
  const events: string[] = [];
  const requests: ApprovalRequest[] = [];
  const context = new CommandContext({});
  const plugin = { signal: context.signal } as PluginContext;
  const invoke: ReturnType<typeof createPluginOperationInvoker> = async (_service, operation, query) => {
    try { return (await operation.run(plugin, query)).data; }
    finally { events.push("context:closed"); }
  };
  const check = (source = "mysql:shared", parameters = {}): HealthProbeExtension => ({
    id: "database", kind: "healthcheck.infra", execution: "probe", description: "Database", access: {},
    probe: "mysql.connectivity@1", parameters,
    approval: { risk: "observe", target: "database", impact: ["SELECT 1"] },
    dataSource: async () => {
      events.push("resolve");
      return { kind: "mysql", id: () => source, clientKey: source, createClient: () => ({
        initialize: async () => { events.push("connect"); }, dispose: async () => { events.push("dispose"); },
      }) };
    },
    run: withSummary({ title: "DB", fields: [] }, async (_context, input) => {
      await input.client!(); events.push("query");
      return { status: "passed", summary: "SELECT 1", evidence: { count: 1 } };
    }),
  });
  const provider = (name: string, item = check()): HealthProvider => ({ namespace: name, name, checks: [item],
    service: { name, workloads: [], component: { name, repository: { forge: { name: "test" }, path: name } } } });
  const interaction = { stopped: false, approve: async (request: ApprovalRequest) => {
    requests.push(request); return { approved: true, source: "prompt" as const };
  } };
  const runner = () => createHealthProbeRunner(context, [provider("a"), provider("b")], invoke, interaction);
  const run = async (execute = runner(), item = check(), name = "a") => execute(provider(name, item), item, {}, () => {});
  return { context, events, requests, check, provider, interaction, runner, run };
}

test("same resolved source probes once across Services, preserves provenance and releases before context closes", async () => {
  const f = fixture(); const run = f.runner();
  const first = await f.run(run);
  Object.assign(first.evidence!, { count: 99 });
  const second = await f.run(run, f.check(), "b");
  expect(second).toMatchObject({ status: "passed", evidence: { count: 1 }, reusedFrom: { service: "a", check: "database" }, dataSourceId: "mysql:shared" });
  expect(f.requests.map(item => item.id)).toEqual(["health-datasource-discovery", "healthcheck:a:database"]);
  expect(f.requests[1]!.target).toBe("database");
  expect(f.events).toEqual(["resolve", "connect", "query", "dispose", "context:closed", "resolve", "context:closed"]);
  await f.run(f.runner()); // New Health session must probe again.
  expect(f.events.filter(item => item === "query")).toHaveLength(2);
  await f.context.disposeClients();
});

test("different source identity, probe policy and implementation remain separate", async () => {
  const f = fixture(); const run = f.runner();
  await f.run(run);
  await f.run(run, f.check("mysql:other"), "b");
  await f.run(run, f.check("mysql:shared", { timeout: 1 }), "b");
  await f.run(run, { ...f.check(), probe: "mysql.other@1" }, "b");
  expect(f.events.filter(item => item === "query")).toHaveLength(4);
  await f.context.disposeClients();
});

for (const stage of ["discovery", "probe"]) test(`denied ${stage} never creates a target client`, async () => {
  const f = fixture();
  f.interaction.approve = async request => { f.requests.push(request); return { approved: stage === "probe" && request.id === "health-datasource-discovery", source: "prompt" }; };
  const run = f.runner();
  expect((await f.run(run)).status).toBe("skipped");
  expect((await f.run(run, f.check(), "b")).status).toBe("skipped");
  expect(f.events).not.toContain("connect");
  expect(f.requests).toHaveLength(stage === "discovery" ? 1 : 2);
  await f.context.disposeClients();
});

for (const status of ["failed", "cancelled"] as const) test(`${status} evidence has explicit reuse semantics`, async () => {
  const f = fixture(); const run = f.runner(); let calls = 0;
  const check = { ...f.check(), run: withSummary({ title: "failure", fields: [] }, async () => {
    calls++; return { status, summary: "failure" };
  }) };
  await f.run(run, check); await f.run(run, check, "b");
  expect(calls).toBe(status === "failed" ? 1 : 2);
  await f.context.disposeClients();
});

test("initialization failures are classified by the probe and reused without another connection", async () => {
  const f = fixture(); const run = f.runner(); const check = f.check(); let attempts = 0;
  check.dataSource = async () => ({ kind: "mysql", id: () => "db", clientKey: "db", createClient: (): Client => ({
    initialize: async () => { attempts++; throw new Error("private-password"); }, dispose: async () => {},
  }) });
  check.run = withSummary({ title: "DB", fields: [] }, async (_context, input) => {
    try { await input.client!(); return { status: "passed", summary: "connected" }; }
    catch { return { status: "failed", summary: "connection failed" }; }
  });
  await f.run(run, check); const second = await f.run(run, check, "b");
  expect(attempts).toBe(1); expect(second.status).toBe("failed"); expect(JSON.stringify(second)).not.toContain("private-password");
  await f.context.disposeClients();
});


test("provider result cannot replace host-owned identity and reuse provenance", async () => {
  const f = fixture(); const check = f.check();
  check.run = withSummary({ title: "DB", fields: [] }, async () => ({ status: "passed", summary: "ok", id: "forged", reusedFrom: { service: "forged", check: "forged" } }));
  const result = await f.run(f.runner(), check);
  expect(result.id).toBeUndefined(); expect(result.reusedFrom).toBeUndefined();
  await f.context.disposeClients();
});


test("resolved descriptions identify approval targets without initializing clients or changing reuse", async () => {
  const f = fixture(); const run = f.runner();
  const described = (description: string) => {
    const check = f.check(); const resolve = check.dataSource!;
    return { ...check, dataSource: async (context: PluginContext, query: {}) => ({ ...await resolve(context, query), description }) };
  };
  f.interaction.approve = async request => {
    expect(f.events).not.toContain("connect");
    f.requests.push(request); return { approved: true, source: "prompt" };
  };
  await f.run(run, described("MySQL db.example:3306/chat"));
  await f.run(run, described("Same source from another Service"), "b");
  expect(f.requests.map(request => request.target)).toEqual(["a, b", "MySQL db.example:3306/chat"]);
  expect(f.events.filter(event => event === "query")).toHaveLength(1);
  await f.context.disposeClients();
});
