import { expect, spyOn, test } from "bun:test";
import { rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createServiceCatalog, defineObservation, defineWorkloadProbeExtension, kubernetesServiceWorkload, withSummary,
  type HealthCaseBindingsExtension, type ServiceDefinition } from "@compforge/doctor-plugin";
import { CommandContext, CommandStatus } from "../src/command";
import { healthCommand } from "../src/health";
import { runHealthSession } from "../src/health/flow";
import { healthProviders } from "../src/health/extensions";
import { buildHealthHtml } from "../src/health/report";
import * as selection from "../src/health/selection";
import * as probes from "../src/health/probe-runner";
import * as targets from "../src/command/kubernetes-target";
import * as caseRuntime from "../src/health/biz/runtime";

const value = { summary: () => ({ title: "fixture", fields: [] }) };
const observation = defineObservation({ kind: "fixture", schemaVersion: 1,
  codec: { encode: () => ({}), decode: () => value } });
const probe = (scope: "self" | "deps") => defineWorkloadProbeExtension({
  id: scope, kind: "workload.probe", health: scope, workload: "main", access: {}, produces: observation,
  run: async () => ({ status: "ok", value }),
});
const consume: HealthCaseBindingsExtension = { id: "checks", kind: "health.case.bindings", access: {},
  run: withSummary({ title: "Checks", fields: [] }, async () => ({ bindings: [] })) };
const api: ServiceDefinition = { name: "api", workloads: [kubernetesServiceWorkload("api")],
  component: { name: "api", repository: { forge: { name: "fixture" }, path: "fixture/api" } },
  extensions: [probe("self"), probe("deps"), consume] };
const plugin = { id: "fixture", version: "1", services: createServiceCatalog([api, { ...api, name: "worker" }]) };

for (const stop of [undefined, "deps", "business"] as const) {
  test(`Health finishes a scope across Services before the next decision; stop=${stop}`, async () => {
    const calls: string[] = [];
    const selected = healthProviders(plugin);
    const result = await runHealthSession(selected, {}, {
      enterScope: async scope => { calls.push(`enter:${scope}`); return scope !== stop; },
      leaveScope: scope => { calls.push(`done:${scope}`); },
      probes: async provider => {
        const scope = provider.probes![0]!.health!;
        expect(provider.probes).toHaveLength(1);
        calls.push(`${provider.name}:${scope}`);
        return [{ probe: scope, scope, status: "ok", observations: [], findings: [] }];
      },
      cases: async provider => { calls.push(`${provider.name}:business`); return []; },
      show: () => {},
    });
    const expected = ["enter:self", "api:self", "worker:self", "done:self", "enter:deps"];
    if (stop !== "deps") expected.push("api:deps", "worker:deps", "done:deps", "enter:business");
    if (!stop) expected.push("api:business", "worker:business", "done:business");
    expect(calls).toEqual(expected);
    expect(result.providers[0]?.probes?.filter(check => check.status !== "not-run").map(check => check.scope)).toEqual(stop === "deps" ? ["self"] : ["self", "deps"]);
    if (stop) {
      expect(result.notRunScopes).toEqual(stop === "deps" ? ["deps", "business"] : ["business"]);
      expect(buildHealthHtml(result)).toContain("未执行层级");
      expect(result.providers.every(provider => provider.cases === undefined)).toBe(true);
    }
  });
}

test("cancellation while awaiting the next scope keeps earlier evidence", async () => {
  const controller = new AbortController();
  const result = await runHealthSession(healthProviders(plugin), {}, {
    signal: controller.signal,
    enterScope: async scope => {
      if (scope === "deps") { controller.abort(); throw new Error("prompt aborted"); }
      return true;
    },
    probes: async () => [{ probe: "self", scope: "self", status: "ok", observations: [], findings: [] }],
    cases: async () => { throw new Error("must not execute Cases"); },
    show: () => {},
  });
  expect(result.providers.every(provider => provider.probes?.filter(check => check.status !== "not-run").length === 1)).toBe(true);
  expect(result.notRunScopes).toEqual(["deps", "business"]);
});

for (const identity of ["tenant", "user"] as const) for (const proceed of [false, true]) {
  test(`command delays ${identity} preparation until biz Service selection; proceed=${proceed}`, async () => {
    const calls: string[] = [];
    const definition = { ...plugin, services: createServiceCatalog([{ ...api,
      extensions: [probe("self"), probe("deps"), { ...consume,
        run: withSummary({ title: "Checks", fields: [] }, async () => {
          calls.push("consume");
          return { bindings: [{ id: "request", workload: "main", producer: { service: "api", source: "requests" } }] };
        }) }],
      cases: [{ id: "requests", load: () => [], produce: {
        access: {},
        ...(identity === "tenant"
          ? { requestTenant: { configured: () => { calls.push("tenant"); return "tenant"; } } }
          : { requestIdentity: { configured: () => { calls.push("user"); return { tenantId: "tenant", userId: "user" }; } } }),
        run: withSummary({ title: "Requests", fields: [] }, async () => ({ cases: [] })),
      } }],
    }]) };
    const context = new CommandContext({}, undefined, { plugin: definition });
    context.ensureEnvironment = async () => {};
    const config = spyOn(targets, "resolveKubernetesCommandConfig").mockResolvedValue({ profileName: "fixture",
      kubernetes: { namespace: "test", namespaceSource: "flag", kubeconfigSource: "flag" } });
    const executor = spyOn(targets, "createKubernetesExecutor").mockReturnValue({
      run: async args => ({ ok: true, stdout: "fixture\nhttps://cluster.example", stderr: "", exitCode: 0, command: args, durationMs: 1, timedOut: false }),
      exec: async () => { throw new Error("unexpected exec"); },
    });
    const checks = spyOn(probes, "runHealthProbes").mockImplementation(async provider => {
      const scope = provider.probes![0]!.health!; calls.push(scope);
      return [{ probe: scope, scope, status: "ok", observations: [], findings: [] }];
    });
    const consent = spyOn(selection, "selectHealthBusinessProviders").mockImplementation(async providers => {
      calls.push("select:biz"); return proceed ? providers : undefined;
    });
    const cases = spyOn(caseRuntime, "caseCheckActions").mockImplementation((_ctx, _executor, _kube, directory, checkpoint) => ({
      directory, checkpoint, signal: context.signal,
      targets: async () => { calls.push("targets"); return { targets: [] }; },
      sender: async () => { throw new Error("unexpected sender"); },
      approve: async () => { throw new Error("unexpected approval"); },
      produce: async () => { throw new Error("unexpected production"); },
    }));
    try {
      const result = await healthCommand.run(context, { services: ["api"] });
      expect(calls).toEqual(["self", "deps", "select:biz",
        ...(proceed ? ["consume", identity, "targets"] : [])]);
      expect(result.output?.providers[0]?.probes).toHaveLength(2);
      if (!proceed) {
        expect(result.output?.notRunScopes).toEqual(["business"]);
        const artifact = result.artifacts[0]!;
        const evidence = JSON.parse(readFileSync(join(artifact.path, "diagnosis.json"), "utf8"));
        expect(evidence.notRunScopes).toEqual(["business"]);
      }
    } finally {
      config.mockRestore(); executor.mockRestore(); checks.mockRestore(); consent.mockRestore(); cases.mockRestore();
      await context.disposeClients();
      for (const artifact of context.artifacts.list()) rmSync(artifact.path, { recursive: true, force: true });
    }
  });
}

for (const lastProvider of [false, true]) {
  test(`mid-scope cancellation records unstarted Probes, last provider=${lastProvider}`, async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const selected = healthProviders(plugin).map(provider => ({ ...provider,
      endpoints: [{ id: "storage", host: "storage.example", port: 80, workload: provider.service.workloads[0]! }] }));
    const endpointCalls: string[] = [];
    const result = await runHealthSession(selected, {}, {
      signal: controller.signal, scopes: ["deps", "business"],
      probes: async provider => {
        calls.push(provider.name);
        if (provider.name === (lastProvider ? "worker" : "api")) controller.abort();
        return [{ probe: "deps", scope: "deps", status: "ok", observations: [], findings: [] }];
      }, endpoints: async provider => {
        endpointCalls.push(provider.name);
        return [{ source: "storage", endpoint: provider.endpoints![0], status: "passed" }];
      }, cases: async () => { throw new Error("must not run Cases"); }, show: () => {},
    });
    expect(calls).toEqual(lastProvider ? ["api", "worker"] : ["api"]);
    expect(result.notRunScopes).toEqual(["business"]);
    expect(result.providers[0]!.probes![0]!.status).toBe("ok");
    expect(result.providers[1]!.probes![0]!.status).toBe(lastProvider ? "ok" : "not-run");
    expect(endpointCalls).toEqual(lastProvider ? ["api"] : []);
    expect(result.providers[0]!.endpoints).toMatchObject([{ source: "storage", status: lastProvider ? "passed" : "not-run" }]);
    expect(result.providers[1]!.endpoints).toMatchObject([{ source: "storage", endpoint: selected[1]!.endpoints[0],
      status: "not-run", reason: "执行前已取消" }]);
    expect(buildHealthHtml(result)).not.toContain("未执行层级：deps");
  });
}

for (const aborted of [false, true]) {
  test(`stopping before deps preserves declared Endpoint coverage without execution; aborted=${aborted}`, async () => {
    const selected = healthProviders(plugin).map(provider => ({ ...provider,
      endpoints: [{ host: "storage.example", port: 80, workload: provider.service.workloads[0]! }] }));
    const result = await runHealthSession(selected, {}, { scopes: ["deps"],
      signal: aborted ? AbortSignal.abort() : undefined, enterScope: async () => false,
      endpoints: async () => { throw new Error("must not execute Endpoints"); },
      cases: async () => [], show: () => {} });
    expect(result.notRunScopes).toEqual(["deps"]);
    for (const provider of result.providers) {
      expect(provider.endpoints).toMatchObject([{ source: "storage.example:80", workload: "main", status: "not-run",
        reason: aborted ? "执行前已取消" : "未继续执行该层级" }]);
    }
  });
}

for (const scope of ["self,deps", "all"] as const) {
  test(`scope is selected first; Service selection is delayed to biz only: ${scope}`, async () => {
    const events: string[] = [];
    const checked = { ...consume, run: withSummary({ title: "Checks", fields: [] }, async context => {
      events.push(`cases:${context.target.service.name}`); return { bindings: [] };
    }) };
    const definition = { ...plugin, services: createServiceCatalog([
      { ...api, extensions: [probe("self"), probe("deps"), checked] },
      { ...api, name: "worker", extensions: [probe("self"), probe("deps"), checked] },
      { ...api, name: "biz-only", extensions: [checked] },
    ]) };
    const context = new CommandContext({}, undefined, { plugin: definition });
    context.ensureEnvironment = async requirements => { if (requirements.kubernetes) events.push("environment"); };
    const scopes = spyOn(selection, "selectHealthScope").mockImplementation(async () => { events.push("scope"); return scope; });
    const services = spyOn(selection, "selectHealthBusinessProviders").mockImplementation(async providers => {
      events.push("services"); return providers.filter(provider => provider.name === "worker");
    });
    const config = spyOn(targets, "resolveKubernetesCommandConfig").mockResolvedValue({ profileName: "fixture",
      kubernetes: { namespace: "test", namespaceSource: "flag", kubeconfigSource: "flag" } });
    const executor = spyOn(targets, "createKubernetesExecutor").mockReturnValue({
      run: async args => ({ ok: true, stdout: "fixture\nhttps://cluster.example", stderr: "", exitCode: 0, command: args, durationMs: 1, timedOut: false }),
      exec: async () => { throw new Error("unexpected exec"); },
    });
    const checks = spyOn(probes, "runHealthProbes").mockImplementation(async provider => {
      const stage = provider.probes![0]!.health!;
      events.push(`${stage}:${provider.name}`);
      return [{ probe: stage, scope: stage, status: "ok", observations: [], findings: [] }];
    });
    try {
      const result = await healthCommand.run(context, {});
      expect(events).toEqual(["scope", "environment", "self:api", "self:worker", "deps:api", "deps:worker",
        ...(scope === "all" ? ["services", "cases:worker"] : [])]);
      if (scope === "self,deps") {
        expect(services).not.toHaveBeenCalled();
        expect(result.output?.providers.map(provider => provider.name)).toEqual(["api", "worker"]);
        expect(result.status).toBe(CommandStatus.Ok);
      } else {
        expect(result.output?.providers[0]?.casesSkipped).toContain("未选择");
        expect(result.output?.providers[1]?.cases).toEqual([]);
        expect(buildHealthHtml(result.output!)).toContain("biz 已跳过");
      }
    } finally {
      scopes.mockRestore(); services.mockRestore(); config.mockRestore(); executor.mockRestore(); checks.mockRestore();
      for (const artifact of context.artifacts.list()) rmSync(artifact.path, { recursive: true, force: true });
      await context.disposeClients();
    }
  });
}

test("quitting deps retains self results and records remaining deps and biz without execution", async () => {
  let stopped = false;
  const calls: string[] = [];
  const result = await runHealthSession(healthProviders(plugin), {}, {
    stopped: () => stopped,
    probes: async (provider, scope) => {
      calls.push(`${scope}:${provider.name}`);
      if (scope === "deps") stopped = true;
      return [{ probe: scope, scope, status: scope === "deps" ? "not-run" : "ok", observations: [], findings: [] }];
    },
    selectBusinessProviders: async () => { throw new Error("must not select Services after quit"); },
    cases: async () => { throw new Error("must not prepare or execute biz"); }, show: () => {},
  });
  expect(calls).toEqual(["self:api", "self:worker", "deps:api"]);
  expect(result.providers[1]?.probes).toMatchObject([{ status: "ok" }, { status: "not-run", reason: "用户结束巡检" }]);
  expect(result.notRunScopes).toEqual(["business"]);
});

test("infra precedes self/deps/biz regardless of requested order, and deps does not run Host checks", async () => {
  const selected = healthProviders(plugin).map(provider => ({ ...provider,
    databaseSources: [{ service: provider.name, dataSource: "db" }],
    s3Sources: [{ service: provider.name, dataSource: "s3" }],
    dataSources: [{ service: provider.name, dataSource: "search" }],
  }));
  for (const infra of [true, false]) {
    const calls: string[] = [];
    await runHealthSession(selected, {}, { scopes: infra ? ["business", "deps", "self", "infra"] : ["deps"],
      enterScope: async scope => { calls.push(`enter:${scope}`); return true; },
      databases: async provider => { calls.push(`db:${provider.name}`); return []; },
      s3: async provider => { calls.push(`s3:${provider.name}`); return []; },
      dataSources: async provider => { calls.push(`search:${provider.name}`); return []; },
      probes: async (provider, scope) => { calls.push(`${scope}:${provider.name}`); return []; },
      cases: async provider => { calls.push(`biz:${provider.name}`); return []; }, show: () => {},
    });
    expect(calls).toEqual(infra ? ["enter:infra", "db:api", "search:api", "s3:api", "db:worker", "search:worker", "s3:worker",
      "enter:self", "self:api", "self:worker", "enter:deps", "deps:api", "deps:worker", "enter:business", "biz:api", "biz:worker"]
      : ["enter:deps", "deps:api", "deps:worker"]);
  }
});
