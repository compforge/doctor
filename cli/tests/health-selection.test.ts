import { expect, mock, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { createServiceCatalog, withSummary, type HealthCaseBindingsExtension, type ServiceDefinition } from "@compforge/doctor-plugin";
import { CommandContext, CommandStatus } from "../src/command";
import { healthCommand } from "../src/health";
import { healthProviders } from "../src/health/extensions";
import * as selection from "../src/health/selection";
import * as targets from "../src/command/kubernetes-target";

const results = { bindings: [] };
const bindings: HealthCaseBindingsExtension = {
  id: "checks", kind: "health.case.bindings", access: {},
  run: withSummary({ title: "Bindings", fields: [] }, async () => results),
};
function service(name: string, extensions: ServiceDefinition["extensions"] = []): ServiceDefinition {
  return { name, aliases: [`${name}-alias`], workloads: [], extensions,
    component: { name, repository: { forge: { name: "fixture" }, path: `fixture/${name}` } } };
}
const plugin = { id: "fixture", version: "1", services: createServiceCatalog([
  service("api", [bindings, { ...bindings, namespace: "plugin/fixture" }]),
  service("worker", [bindings]), service("unrelated"),
]) };

test("default health discovers every supported Service, not product statistics or unrelated Services", () => {
  const providers = healthProviders(plugin);
  expect(providers.map(provider => provider.name)).toEqual(["api", "worker"]);
  expect(providers.map(provider => provider.namespace)).toEqual([
    "plugin/fixture/service/api", "plugin/fixture/service/worker",
  ]);
  expect(healthProviders(plugin, ["worker-alias", "worker"])).toHaveLength(1);
  expect(() => healthProviders(plugin, ["unrelated"])).toThrow("health.case.bindings");
  expect(() => healthProviders(plugin, ["missing"])).toThrow("Unknown Service");
  expect(() => healthProviders(plugin, [])).toThrow("empty");
  for (const services of [[], [service("unrelated")], [service("api", [{ ...bindings, namespace: "plugin/fixture" }])]]) {
    expect(() => healthProviders({ ...plugin, services: createServiceCatalog(services) })).toThrow("没有支持 health");
  }
});

test("interactive health preselects every candidate and respects the user's subset", async () => {
  const prompt = mock(async (input: { choices: readonly { name: string }[]; defaults?: readonly string[] }) => {
    expect(input.choices.map(choice => choice.name)).toEqual(["api", "worker"]);
    expect(input.defaults).toEqual(["api", "worker"]);
    return ["worker"];
  });
  const selected = await selection.selectHealthBusinessProviders(healthProviders(plugin), true, prompt);
  expect(selected?.map(provider => provider.name)).toEqual(["worker"]);
  expect(prompt).toHaveBeenCalledTimes(1);
});

test("explicit Services and noninteractive defaults skip prompting; cancellation does not default back to all", async () => {
  const prompt = mock(async () => undefined);
  expect((await selection.selectHealthBusinessProviders(healthProviders(plugin, ["worker-alias"]), false, prompt))?.map(provider => provider.name)).toEqual(["worker"]);
  expect((await selection.selectHealthBusinessProviders(healthProviders(plugin), false, prompt))?.map(provider => provider.name)).toEqual(["api", "worker"]);
  expect(prompt).not.toHaveBeenCalled();
  expect(await selection.selectHealthBusinessProviders(healthProviders(plugin), true, prompt)).toBeUndefined();
  expect(await selection.selectHealthBusinessProviders(healthProviders(plugin), true, async () => [])).toBeUndefined();
});

test("cancelling scope selection stops health before environment preparation", async () => {
  const selected = spyOn(selection, "selectHealthScope").mockResolvedValue(undefined);
  const context = new CommandContext({}, undefined, { plugin });
  const environment = mock(async () => {});
  context.ensureEnvironment = async requirements => { if (requirements.kubernetes) await environment(); };
  try {
    expect((await healthCommand.run(context, {})).status).toBe(CommandStatus.Cancelled);
    expect(environment).not.toHaveBeenCalled();
  } finally { selected.mockRestore(); await context.disposeClients(); }
});

test("noninteractive command runs all supported Services once, or only explicitly selected Services", async () => {
  const calls: string[] = [];
  const checks = { ...bindings, run: withSummary({ title: "Bindings", fields: [] }, async context => {
    calls.push(context.target.service.name); return results;
  }) };
  const definition = { ...plugin, services: createServiceCatalog([
    service("api", [checks, { ...checks, namespace: "plugin/fixture" }]),
    service("worker", [checks]), service("unrelated"),
  ]) };
  const config = spyOn(targets, "resolveKubernetesCommandConfig").mockResolvedValue({ profileName: "fixture",
    kubernetes: { namespace: "test", namespaceSource: "flag", kubeconfigSource: "flag" } });
  const executor = spyOn(targets, "createKubernetesExecutor").mockReturnValue({
    run: async args => {
      if (args[0] !== "config") throw new Error("unexpected I/O");
      return { ok: true, stdout: "fixture\nhttps://cluster.example", stderr: "", exitCode: 0, command: args, durationMs: 1, timedOut: false };
    }, exec: async () => { throw new Error("unexpected exec"); },
  });
  try {
    for (const service of [undefined, "worker-alias"]) {
      calls.length = 0;
      const context = new CommandContext({}, undefined, { plugin: definition });
      context.ensureEnvironment = async () => {};
      try {
        const result = await healthCommand.run(context, { services: service === undefined ? undefined : [service], yes: true });
        expect(result.status).toBe(CommandStatus.Ok);
        expect(calls).toEqual(service ? ["worker"] : ["api", "worker"]);
        expect(result.output?.providers.map(provider => provider.name)).toEqual(calls);
      } finally {
        for (const artifact of context.artifacts.list()) rmSync(artifact.path, { recursive: true, force: true });
        await context.disposeClients();
      }
    }
  } finally { config.mockRestore(); executor.mockRestore(); }
});


test("interactive scope selection defaults to infra/self/deps; explicit scopes and noninteractive calls do not ask", async () => {
  const prompt = mock(async (input: { defaults?: readonly string[]; choices: readonly { name: string }[] }) => {
    expect(input.defaults).toEqual(["infra", "self", "deps"]);
    expect(input.choices.map(choice => choice.name)).toEqual(["infra", "self", "deps", "biz"]);
    return ["deps", "biz"];
  });
  expect(await selection.selectHealthScope(undefined, true, prompt)).toBe("deps,biz");
  expect(await selection.selectHealthScope("all", true, prompt)).toBe("all");
  expect(await selection.selectHealthScope("biz", true, prompt)).toBe("biz");
  expect(await selection.selectHealthScope(undefined, false, prompt)).toBe("all");
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(await selection.selectHealthScope(undefined, true, async () => [])).toBeUndefined();
});
