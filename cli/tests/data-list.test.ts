import { dataTypeResult } from "../src/collect/data/list";
import { expect, test, mock } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServiceCatalog, withSummary, type PluginContext, type DataListExtension, type PluginDefinition, type ServiceDefinition } from "@compforge/doctor-plugin";
import { CommandContext, CommandStatus } from "../src/command";
import { prepareDataCommand, runCollectData } from "../src/collect/data";
import { dataCommand } from "../src/collect/data/command";
import { dataListProviders } from "../src/collect/data/extensions";
import { parseDataQueries } from "../src/collect/data/query";
import { selectDataQueryServices } from "../src/collect/data/config";
import { createDoctorProgram } from "../src/app/main";
import { SerializeContext } from "../src/command/serialization/context";
import { renderForDelivery } from "./report-fixture";
import { inspectExtension } from "../../packages/plugin/tests/extension-fixture";

const calls: string[] = [];
const component = { name: "fixture", repository: { forge: { name: "test" }, path: "data" } };
const list = (bizType: string, fail = false): DataListExtension => ({
  id: `list-${bizType}`, kind: "data.list", bizType, description: `${bizType} records`, access: {},
  run: withSummary({ title: bizType, fields: [] }, async (context, query) => {
    calls.push(`${context.target.service.name}/${bizType}`);
    if (fail) throw new Error("source offline");
    return { items: [{ customField: `${context.target.service.name}-${query.page}` }], page: query.page, pageSize: query.pageSize, total: 42 };
  }),
});
const service = (name: string, extensions: ServiceDefinition["extensions"]): ServiceDefinition => ({ name, aliases: [`alias-${name}`], component, workloads: [], extensions });
const plugin: PluginDefinition = { id: "test", version: "1", services: createServiceCatalog([
  service("first", [list("bot"), list("skill"), inspectExtension({ access: {}, accepts: ["biz_id"], provides: ["record"],
    inspect: async (_context, queries) => queries.map(({ identity }) => ({ identity, status: "collected", result: {
      resolution: { inputId: identity.value, resolvedAs: identity.kind, identifiers: {} }, facts: [],
    } })) })]),
  service("second", [list("bot", true)]),
]) };
const executor = { run: async () => { throw new Error("unexpected target access"); }, exec: async () => { throw new Error("unexpected target access"); } };

for (const mixed of [false, true]) test(`type queries preserve independent pages, failures and ID results (mixed=${mixed})`, async () => {
  calls.length = 0;
  const context = new CommandContext({});
  const serialized = mkdtempSync(join(tmpdir(), "doctor-data-list-test-"));
  try {
    const prepared = await prepareDataCommand({ bizIds: mixed ? ["id-a"] : [], bizTypes: ["bot", "skill", "bot"], namespace: "test", page: 2, pageSize: 3 }, plugin.services, context, executor);
    const contexts = Object.fromEntries(["first", "second"].map(name => [name, {
      signal: context.signal, target: { service: { name } },
    } as PluginContext]));
    const result = await runCollectData(prepared!, plugin, contexts);
    expect(calls).toEqual(["first/bot", "first/skill", "second/bot"]);
    expect(result.status).toBe(CommandStatus.Partial);
    expect(result.output!.items).toHaveLength(mixed ? 1 : 0);
    expect(result.output!.typeResults).toMatchObject([
      { service: "first", bizType: "bot", status: "ok", data: { page: 2, pageSize: 3, total: 42, items: [{ customField: "first-2" }] } },
      { service: "first", bizType: "skill", status: "ok", data: { total: 42 } },
      { service: "second", bizType: "bot", status: "failed", reason: "source offline" },
    ]);
    await SerializeContext.create(serialized, dataCommand, result);
    const facts = JSON.parse(readFileSync(join(serialized, "raw/facts.json"), "utf8"));
    expect(facts.typeResults.map(dataTypeResult)).toEqual(result.output!.typeResults);
    const summary = readFileSync(join(serialized, "summary.md"), "utf8");
    expect(summary).toContain("total=42");
    expect(summary).toContain("source offline");
    const rendered = await renderForDelivery(context, dataCommand, result);
    expect(rendered.context.failures).toEqual([]);
    expect(rendered.report.sections[0]!.pages).toHaveLength(mixed ? 2 : 1);
  } finally {
    for (const artifact of context.artifacts.list()) rmSync(dirname(artifact.path), { recursive: true, force: true });
    rmSync(serialized, { recursive: true, force: true });
    await context.disposeClients();
  }
});

test("service filtering and static help discover types without executing providers", async () => {
  const run = mock(list("bot").run);
  const catalog = createServiceCatalog([service("first", [{ ...list("bot"), run }]), service("second", [list("skill")])]);
  expect(selectDataQueryServices({ bizIds: [], bizTypes: ["bot"], services: ["alias-first"] }, catalog)).toEqual(["first"]);
  expect(() => selectDataQueryServices({ bizIds: [], bizTypes: ["skill"], services: ["first"] }, catalog)).toThrow("不支持");
  const program = createDoctorProgram({ plugin: { ...plugin, services: catalog } }).exitOverride();
  let help = "";
  const command = program.commands.find(command => command.name() === "data")!.exitOverride();
  command.configureOutput({ writeOut: text => { help += text; }, writeErr: () => {} });
  try { await program.parseAsync(["data", "-s", "first", "--help"], { from: "user" }); } catch (error) {
    expect((error as { code: string }).code).toBe("commander.helpDisplayed");
  }
  expect(help).toContain("bot records");
  expect(help).not.toContain("skill records");
  expect(run).not.toHaveBeenCalled();
});

test("duplicate type registrations and invalid pagination fail before target access", () => {
  const catalog = createServiceCatalog([service("first", [list("bot"), { ...list("bot"), id: "duplicate" }])]);
  expect(() => dataListProviders(catalog)).toThrow("Duplicate");
  for (const opts of [{ page: 0 }, { page: 1.5 }, { pageSize: 1001 }, { page: "NaN" }]) {
    expect(() => parseDataQueries({ bizIds: [], bizTypes: ["bot"], ...opts })).toThrow();
  }
  expect(() => parseDataQueries({ bizIds: ["a"], page: 2 })).toThrow("需要 --biz-type");
});
