import { expect, mock, spyOn, test } from "bun:test";
import { createServiceCatalog, kubernetesServiceWorkload, withSummary, type CaseProduceResult,
  type HealthCaseBindingsResult, type PluginDefinition } from "@compforge/doctor-plugin";
import { doctorCaseCatalog } from "../src/case/catalog";
import { listDoctorCases, formatCaseList } from "../src/case/list";
import { caseListCommand } from "../src/case/list-command";
import { createDoctorProgram } from "../src/app/main";
import * as execution from "../src/app/command";
import { CommandContext, CommandStatus } from "../src/command";

const component = { name: "fixture", repository: { forge: { name: "test" }, path: "test" } };
const item: CaseProduceResult["cases"][number] = {
  case: { id: "download", input: { protocol: "http", method: "GET" }, judge: { e2e: { http: { status: [200] } } } },
  targets: [{ id: "primary", url: "https://files.test/skill.zip?X-Amz-Signature=SECRET", headers: { Authorization: "TOKEN" } }],
};
const bindings: HealthCaseBindingsResult = { bindings: [{
  id: "skills", workload: "main", producer: { service: "kb", source: "skills" }, via: ["hibot"],
}] };
function fixture() {
  const produce = mock(async () => ({ cases: [item] } as CaseProduceResult));
  const consume = mock(async () => bindings);
  const runner = mock(async () => { throw new Error("must not create runner"); });
  const plugin: PluginDefinition = { id: "test", version: "1", services: createServiceCatalog([
    { component, name: "kb", aliases: ["knowledge"], workloads: [], cases: [{ id: "skills",
      load: () => [{ caseset: "skill-download", cases: [item.case] }],
      produce: { access: {}, run: withSummary({ title: "Skills", fields: [] }, async () => ({ cases: [item] })) },
      runner: { endpoint: { host: "kb", port: 80 }, access: {}, supports: () => true, run: runner },
    }] },
    { component, name: "hibot", workloads: [] },
    ...["bedbox", "sandbox"].map(name => ({ component, name, workloads: [kubernetesServiceWorkload(name)],
      extensions: [{ id: "downloads", kind: "health.case.bindings" as const, access: {},
        run: withSummary({ title: "Downloads", fields: [] }, async () => bindings) }] })),
  ]) };
  return { plugin, produce, consume, runner, actions: { produce, consume, signal: new AbortController().signal },
    catalog: doctorCaseCatalog(plugin, undefined, "/tmp") };
}

test("lists provider, forwarder, all consumers and redacted URLs; samples once without executing", async () => {
  const f = fixture();
  const result = await listDoctorCases(f.catalog, f.plugin, { caseset: "skill-download" }, f.actions);
  expect(result.entries).toHaveLength(1);
  expect(result.entries[0]).toMatchObject({ provider: "kb", caseId: "download",
    consumers: [{ service: "bedbox", workload: "main", via: ["hibot"] }, { service: "sandbox", workload: "main", via: ["hibot"] }] });
  expect(f.produce).toHaveBeenCalledTimes(1);
  expect(f.runner).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain("SECRET");
  expect(JSON.stringify(result)).not.toContain("TOKEN");
  expect(formatCaseList(result)).toContain("bedbox/main");
  expect(formatCaseList(result)).toContain("未执行");
});

for (const service of ["knowledge", "hibot", "bedbox"]) test(`filters by provider alias, forwarder or consumer: ${service}`, async () => {
  const f = fixture();
  expect((await listDoctorCases(f.catalog, f.plugin, { services: [service] }, f.actions)).entries).toHaveLength(1);
});

test("empty samples and provider failures retain the declared relation and explain the gap", async () => {
  for (const fail of [false, true]) {
    const f = fixture();
    f.produce.mockImplementation(async () => {
      if (fail) throw new Error("sign failed https://files.test/?token=SECRET");
      return { cases: [], reason: "No Skill sample" };
    });
    const result = await listDoctorCases(f.catalog, f.plugin, { caseset: "skill-download" }, f.actions);
    expect(result.entries[0]?.consumers).toHaveLength(2);
    expect(result.entries[0]?.targets).toEqual([]);
    expect(result.gaps).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  }
});

test("binding failure is visible while the independent provider remains listed", async () => {
  const f = fixture();
  f.consume.mockImplementation(async () => { throw new Error("binding access denied"); });
  const result = await listDoctorCases(f.catalog, f.plugin, { services: ["kb"] }, f.actions);
  expect(result.entries[0]?.targets).toHaveLength(1);
  expect(result.gaps).toHaveLength(2);
  expect(result.entries[0]?.consumers).toEqual([]);
});

test("unbound offline Cases do not resolve environment or fabricate URLs", async () => {
  const f = fixture();
  const result = await listDoctorCases(doctorCaseCatalog(undefined, undefined, "/tmp"), undefined,
    { caseset: "doctor_http" }, f.actions);
  expect(result.entries.length).toBeGreaterThan(0);
  expect(result.entries.every(entry => entry.targets.length === 0)).toBe(true);
  expect(f.produce).not.toHaveBeenCalled();
  expect(f.consume).not.toHaveBeenCalled();
});

test("runtime-only sources are listed and partial sample reasons remain gaps", async () => {
  const f = fixture();
  f.plugin.services.find("kb")!.cases![0]!.load = () => [];
  f.produce.mockResolvedValue({ cases: [item], truncated: { reason: "limit" } });
  const result = await listDoctorCases(doctorCaseCatalog(f.plugin, undefined, "/tmp"), f.plugin, { services: ["kb"] }, f.actions);
  expect(result.entries[0]?.caseId).toBe("download");
  expect(result.gaps).toContain("kb/skills: limit");
});

test("list/send conflict fails before loading a plugin or accessing the environment", async () => {
  const loadPlugin = mock(async () => undefined);
  const context = new CommandContext({}, undefined, { loadPlugin });
  const result = await caseListCommand.run(context, { send: true });
  expect(result.status).toBe(CommandStatus.Failed);
  expect(loadPlugin).not.toHaveBeenCalled();
});

for (const flag of ["--list", "-l"]) test(`CLI ${flag} routes to the list command without selection or send`, async () => {
  const run = spyOn(execution, "runCommand").mockResolvedValue(undefined);
  try {
    const program = createDoctorProgram({ commands: "case" });
    program.exitOverride();
    await program.parseAsync(["-n", "qa", "case", flag, "-s", "kb", "--caseset", "skills", "-f", "json"], { from: "user" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).toBe(caseListCommand);
    expect(run.mock.calls[0]![1].format).toBe("json");
    expect(run.mock.calls[0]![2]).toMatchObject({ namespace: "qa", services: ["kb"], caseset: "skills" });
  } finally { run.mockRestore(); }
});

test("listed URL resolves the Case path exactly as execution does", async () => {
  const f = fixture();
  f.produce.mockResolvedValue({ cases: [{ ...item, case: { ...item.case, input: { ...item.case.input, path: "/probe" } } }] });
  const result = await listDoctorCases(f.catalog, f.plugin, { caseset: "skill-download" }, f.actions);
  expect(result.entries[0]?.targets[0]?.url).toBe("https://files.test/probe");
});
