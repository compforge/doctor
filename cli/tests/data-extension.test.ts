import { withSummary } from "@compforge/doctor-plugin";
import { expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { createServiceCatalog, FACTS_INSPECT_KIND, type FactsInspectExtension, type PluginDefinition, type ServiceDefinition } from "@compforge/doctor-plugin";
import type { Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import { dataCommand, type DataInput } from "../src/collect/data/command";
import { CommandContext, CommandStatus, defineCommand } from "../src/command";
import { prepareDataCommand, runCollectData } from "../src/collect/data";
import { dataProviders } from "../src/collect/data/extensions";
import { projectDataServiceEvidence } from "../src/collect/data/detector";
import { evaluatePluginCapabilities } from "../src/command/plugin-capability";
import { PLUGIN_COMMAND_CAPABILITIES } from "../src/command/plugin-command-capabilities";

const component = { name: "fixture", repository: { forge: { name: "test" }, path: "fixture" } };
const need = (resource: string) => ({ rule: { verb: "get", resource }, requirement: "required" as const, purpose: "test data access" });
const extension = (overrides: Partial<FactsInspectExtension> = {}): FactsInspectExtension => ({
  id: "records", kind: FACTS_INSPECT_KIND, access: { kubernetes: [need("configmaps")] },
  accepts: ["biz_id"], provides: ["record"], run: withSummary({ title: "Fixture", fields: [] }, async (_context, queries) => queries.map(({ identity }) => ({
    identity, status: "collected", result: {
      resolution: { inputId: identity.value, resolvedAs: "record", identifiers: {} },
      facts: [{ factType: "value", kind: "record", schemaVersion: 1, value: { id: identity.value } }]
    },
  }))), ...overrides,
});
const service = (name: string, ext: FactsInspectExtension): ServiceDefinition => ({
  name,
  component,
  workloads: [],
  extensions: [...[ext]]
});
const plugin = (services: ServiceDefinition[]): PluginDefinition => ({ id: "extensions", version: "1", services: createServiceCatalog(services) });
const args = { bizIds: ["a", "b"], namespace: "test", services: "records", format: "json" };
function executor(events: string[], allowed = true): Executor {
  return {
    run: async command => {
      events.push(command.join(" "));
      const stdout = command[0] === "auth" ? (allowed ? "yes" : "no")
        : command[0] === "config" ? "test-context\nhttps://test.invalid" : "{}";
      return { ok: true, stdout, stderr: "", exitCode: 0, durationMs: 0, timedOut: false, command };
    },
    exec: async () => { throw new Error("unexpected exec"); },
  };
}
async function cleanup(context: CommandContext) {
  for (const artifact of context.artifacts.list()) rmSync(dirname(artifact.path), { recursive: true, force: true });
  await context.disposeClients();
}

test("Data prepares only selected Extension access, then invokes native facts.inspect with scoped context and producer identity", async () => {
  const events: string[] = [];
  const dispose = mock(() => { });
  const otherKind = mock(async () => ["static"]);
  let calls = 0;
  const base = extension();
  const records = service("records", extension({
    run: withSummary({ title: "Fixture", fields: [] }, async (context, queries) => {
      calls++;
      events.push("extension.run");
      expect(events[0]).toBe("auth can-i get configmaps");
      expect(context.target.service.name).toBe("records");
      await expect(context.infra.kubernetes.list("secrets")).rejects.toThrow("未声明");
      context.onDispose(dispose);
      return [...(await base.run(context, queries)).data].reverse();
    })
  }));
  records.extensions = [...records.extensions!, { id: "static", kind: "custom.describe", access: { kubernetes: [need("secrets")] }, run: withSummary({ title: "Fixture", fields: [] }, otherKind) }];
  const configured = plugin([records, service("unselected", extension({ access: { kubernetes: [need("secrets")] } }))]);
  expect(evaluatePluginCapabilities(configured, PLUGIN_COMMAND_CAPABILITIES.data).runnable).toBeTrue();
  const context = new CommandContext({});
  try {
    const prepared = await prepareDataCommand(args, configured.services, context, executor(events));
    expect(events).toEqual(["auth can-i get configmaps"]);
    expect(calls).toBe(0);
    expect(context.artifacts.list()).toEqual([]);
    const result = await runCollectData(prepared!, configured);
    expect(result.status).toBe(CommandStatus.Ok);
    expect(calls).toBe(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(otherKind).not.toHaveBeenCalled();
    expect(events.some(item => item.includes("secrets"))).toBeFalse();
    for (const item of result.output!.items) {
      const facts = item.diagnosis!.evidence.facts;
      expect(facts.services.records!.inspect).toMatchObject({ status: "collected", queryable: true });
      expect(facts.services.records).not.toHaveProperty("target");
      expect(facts.capabilityResults[0]).toMatchObject({ extension: "records", identity: { value: item.bizId } });
      expect(projectDataServiceEvidence(item.diagnosis!.evidence, configured.id).facts[0]?.producer)
        .toEqual({ origin: "plugin", plugin: configured.id, service: "records", id: "records" });
    }
  } finally { await cleanup(context); }
});

test("required access denial stops prepare before any provider execution or output", async () => {
  const run = mock(async () => []);
  const configured = plugin([service("records", extension({ run: withSummary({ title: "Fixture", fields: [] }, run) }))]);
  const context = new CommandContext({});
  try {
    await expect(prepareDataCommand(args, configured.services, context, executor([], false))).rejects.toThrow("缺少必须");
    expect(run).not.toHaveBeenCalled();
    expect(context.artifacts.list()).toEqual([]);
  } finally { await cleanup(context); }
});

test("Data validates a malformed outcome per query and retains a healthy sibling", async () => {
  const configured = plugin([service("records", extension({
    access: {}, run: withSummary({ title: "Fixture", fields: [] }, async (_context, queries) => [
      {
        identity: queries[0]!.identity, status: "collected", result: {
          resolution: { inputId: "a", resolvedAs: "record", identifiers: {} },
          facts: [{ factType: "value", kind: "undeclared", schemaVersion: 1, value: "bad" }]
        }
      },
      {
        identity: queries[1]!.identity, status: "collected", result: {
          resolution: { inputId: "b", resolvedAs: "record", identifiers: {} },
          facts: [{ factType: "value", kind: "record", schemaVersion: 1, value: "good" }]
        }
      },
    ])
  }))]);
  const context = new CommandContext({});
  try {
    const prepared = await prepareDataCommand(args, configured.services, context, executor([]));
    const result = await runCollectData(prepared!, configured);
    expect(result.status).toBe(CommandStatus.Partial);
    expect(result.output!.items.map(item => item.status)).toEqual([CommandStatus.Failed, CommandStatus.Ok]);
  } finally { await cleanup(context); }
});

test("Data rejects ambiguous facts.inspect producers instead of silently using registration order", () => {
  const records = service("records", extension());
  records.extensions = [extension(), extension({ id: "other" })];
  expect(() => dataProviders(createServiceCatalog([records]))).toThrow("one facts.inspect Extension per Service");
});

for (const nested of [false, true]) test(`Data checked entry point preflights before run (nested=${nested})`, async () => {
  const run = mock(async () => []);
  const configured = plugin([service("records", extension({ run: withSummary({ title: "Fixture", fields: [] }, run) }))]);
  const denied = executor([], false);
  const context = new CommandContext({
    kubernetes: {
      kubeconfig: { source: "test" }, context: "test-context",
      channel: { available: true, client: { ok: true, stdout: "", stderr: "", exitCode: 0, durationMs: 0, timedOut: false, command: [] } },
    }
  }, undefined, { plugin: configured });
  const scoped = context.kubernetes(denied);
  context.kubernetes = () => scoped;
  const parent = defineCommand<DataInput, unknown>({ name: "parent", prepare: async (_context, input) => input, run: (ctx, input) => dataCommand.run(ctx, input) });
  try {
    const result = await (nested ? parent : dataCommand).run(context, args);
    expect(result.status).toBe(CommandStatus.Failed);
    expect("reason" in result ? result.reason : undefined).toContain("缺少必须");
    expect(run).not.toHaveBeenCalled();
    expect(context.artifacts.list()).toEqual([]);
  } finally { await cleanup(context); }
});

test("an explicitly selected Service does not inherit an unselected Service's ambiguous kind", async () => {
  const unselected = service("unselected", extension());
  unselected.extensions = [extension(), extension({ id: "other" })];
  const configured = plugin([service("records", extension({ access: {} })), unselected]);
  const context = new CommandContext({});
  try {
    const prepared = await prepareDataCommand(args, configured.services, context, executor([]));
    expect(prepared?.providers.map(item => item.name)).toEqual(["records"]);
  } finally { await cleanup(context); }
});
