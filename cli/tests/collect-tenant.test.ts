import { PageValue, pageCodec } from "../../packages/plugin/tests/page-value-fixture";
import { expect, mock, spyOn, test } from "bun:test";
import { dirname, join } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServiceCatalog, withSummary, type DataPageExtension, type PluginContext, type PluginDefinition } from "@compforge/doctor-plugin";
import { CommandContext, CommandStatus } from "../src/command";
import { prepareDataCommand, runCollectData } from "../src/collect/data";
import { tenantCommand, createTenantInput } from "../src/collect/tenant/command";
import { createDoctorProgram } from "../src/app/main";
import * as execution from "../src/app/command";
import * as tenantAccess from "../src/collect/tenant/access";
import * as dataContext from "../src/collect/data/context";
import { SerializeContext } from "../src/command/serialization/context";
import { renderForDelivery } from "./report-fixture";

const queries: unknown[] = [];
const bots: DataPageExtension = {
  id: "bots", kind: "data.page", codec: pageCodec, bizType: "bot", description: "Tenant bots", supportsTenant: true, access: {},
  run: withSummary({ title: "Bots", fields: [] }, async (_context, query) => {
    queries.push(query);
    const records = [{ id: "a", tenantId: "t1" }, { id: "b", tenantId: "t2" }, { id: "c", tenantId: "t1" }];
    const selected = records.filter(record => !query.tenantId || record.tenantId === query.tenantId);
    return { items: selected.slice((query.page - 1) * query.pageSize, query.page * query.pageSize).map(record => new PageValue(record)), total: selected.length, page: query.page, pageSize: query.pageSize };
  }),
};
const unscoped = { ...bots, id: "global", bizType: "global", supportsTenant: false, run: mock(bots.run) };
const offline = { ...bots, id: "offline", bizType: "offline", run: withSummary({ title: "Offline", fields: [] }, async () => { throw new Error("source offline"); }) };
const plugin: PluginDefinition = { id: "fixture", version: "1", services: createServiceCatalog([{
  name: "control", component: { name: "control", repository: { forge: { name: "test" }, path: "control" } }, workloads: [], extensions: [bots, unscoped, offline],
}]) };
const executor = { run: async () => { throw new Error("unexpected target access"); }, exec: async () => { throw new Error("unexpected target access"); } };

test("tenant pages preserve tenant constraints, totals, failures and evidence through shared execution", async () => {
  const context = new CommandContext({});
  const root = mkdtempSync(join(tmpdir(), "tenant-pages-"));
  queries.length = 0;
  try {
    const prepared = await prepareDataCommand({ tenantId: "t1", tenantName: "alpha", bizTypes: ["bot", "offline", "global"], page: 2, pageSize: 1, namespace: "ns" }, plugin.services, context, executor);
    const result = await runCollectData(prepared!, plugin, { control: { signal: context.signal, target: { service: { name: "control" } } } as PluginContext });
    expect(queries).toEqual([{ tenantId: "t1", page: 2, pageSize: 1, maxBytes: expect.any(Number) }]);
    expect(unscoped.run).not.toHaveBeenCalled();
    expect(result.status).toBe(CommandStatus.Partial);
    expect(result.output).toMatchObject({ tenant: { id: "t1", name: "alpha" }, items: [], typeResults: [
      { bizType: "bot", status: "ok", data: { total: 2, items: [{ data: { id: "c", tenantId: "t1" } }] } },
      { bizType: "global", status: "failed", reason: expect.stringContaining("不支持租户过滤") },
      { bizType: "offline", status: "failed", reason: "source offline" },
    ] });
    expect(result.artifacts.every(artifact => artifact.command === "tenant")).toBeTrue();
    await SerializeContext.create(root, tenantCommand, result);
    expect(JSON.parse(readFileSync(join(root, "collection.json"), "utf8")).target.tenant_id).toBe("t1");
    expect(readFileSync(join(root, "summary.md"), "utf8")).toContain("alpha（t1）");
    const rendered = await renderForDelivery(context, tenantCommand, result);
    expect(rendered.context.failures).toEqual([]);
    expect(rendered.report.title).toBe("doctor tenant");
  } finally {
    for (const artifact of context.artifacts.list()) rmSync(dirname(artifact.path), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    await context.disposeClients();
  }
});

test("tenant without types selects only registered tenant-capable types", async () => {
  const context = new CommandContext({});
  const prepared = await prepareDataCommand({ tenantId: "t1", namespace: "ns" }, plugin.services, context, executor);
  expect(prepared!.listProviders!.map(provider => provider.extension.bizType)).toEqual(["bot", "offline"]);
  await expect(prepareDataCommand({ tenantId: "t1", namespace: "ns", bizTypes: ["missing"] }, plugin.services, context, executor)).rejects.toThrow("不支持");
  await context.disposeClients();
});

test("Tenant and Data expose distinct selectors; tenant forwards repeated types and pagination", async () => {
  const program = createDoctorProgram({ plugin });
  const tenant = program.commands.find(command => command.name() === "tenant")!;
  const data = program.commands.find(command => command.name() === "data")!;
  expect(tenant.helpInformation()).toContain("--biz-type");
  expect(tenant.helpInformation()).not.toContain("--biz-id");
  expect(data.helpInformation()).not.toContain("--biz-type");
  expect(data.helpInformation()).not.toContain("--tenant");
  const run = spyOn(execution, "runCommand").mockResolvedValue(undefined);
  try {
    await program.parseAsync(["tenant", "--tenant-name", "alpha", "--biz-type", "bot", "--biz-type", "offline", "-s", "control", "--page", "2"], { from: "user" });
    expect(run.mock.calls[0]![0]).toBe(tenantCommand);
    expect(run.mock.calls[0]![2]).toMatchObject({ tenantName: "alpha", bizTypes: ["bot", "offline"], services: ["control"], page: "2" });
  } finally { run.mockRestore(); }
});

test("tenant query reuse includes identity, types, services and page", () => {
  const input = { tenantId: "t1", bizTypes: ["bot"], services: ["control"], page: 1 };
  const key = createTenantInput(input).idempotencyKey!();
  for (const change of [{ tenantId: "t2" }, { bizTypes: ["model"] }, { services: ["other"] }, { page: 2 }, { pageSize: 1 }]) {
    expect(createTenantInput({ ...input, ...change }).idempotencyKey!()).not.toBe(key);
  }
});

for (const input of [{ tenantId: " " }, { tenantName: " " }, { tenantId: "t1", tenantName: "alpha" }, { tenantId: "t1", page: 0 }]) {
  test(`invalid tenant query fails before external work: ${JSON.stringify(input)}`, async () => {
    const loadPlugin = mock(async () => plugin);
    const context = new CommandContext({}, undefined, { loadPlugin });
    const result = await tenantCommand.run(context, input);
    expect(result.status).toBe(CommandStatus.Failed);
    expect(loadPlugin).not.toHaveBeenCalled();
  });
}


for (const byName of [false, true]) test(`Tenant resolves names but accepts IDs without directory access (name=${byName})`, async () => {
  const resolve = mock(async () => ({ id: "t1", name: "alpha", displayName: "Alpha" }));
  const list = mock(async () => []);
  const directoryExtension = { id: "resolve", kind: "tenant.resolve", endpoint: { host: "directory", port: 80 }, access: {},
    run: withSummary({ title: "Tenant", fields: [] }, async () => ({ id: "t1", name: "alpha", displayName: "Alpha" })) };
  const catalog = createServiceCatalog(plugin.services.services.map(service => ({ ...service, extensions: [...service.extensions ?? [], directoryExtension] })));
  const context = new CommandContext({}, undefined, { plugin: { ...plugin, services: catalog } });
  const environment = spyOn(context, "ensureEnvironment").mockResolvedValue(undefined);
  const access = spyOn(tenantAccess, "openTenantDirectoryAccess").mockResolvedValue({
    config: { profileName: "test", kubernetes: { namespace: "ns", namespaceSource: "flag", kubeconfigSource: "test" } },
    executor, kube: { namespace: "ns", kubeconfig: undefined, context: undefined }, databaseIdentity: undefined, directory: { listActive: list, getByName: resolve },
  });
  const prepare = spyOn(dataContext, "prepareDataCommand").mockResolvedValue(undefined);
  try {
    await tenantCommand.run(context, { ...(byName ? { tenantName: "alpha" } : { tenantId: "t1" }), bizTypes: ["bot"] });
    expect(prepare.mock.calls[0]![0]).toMatchObject({ tenantId: "t1", bizTypes: ["bot"] });
    expect(resolve).toHaveBeenCalledTimes(byName ? 1 : 0);
    expect(list).not.toHaveBeenCalled();
  } finally { prepare.mockRestore(); access.mockRestore(); environment.mockRestore(); await context.disposeClients(); }
});
