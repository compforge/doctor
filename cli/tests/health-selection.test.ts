import { expect, mock, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { createServiceCatalog, withSummary, type FacetSummarizeExtension, type ServiceDefinition } from "@compforge/doctor-plugin";
import { CommandContext, CommandStatus } from "../src/command";
import { healthCommand } from "../src/health";
import { healthProviders } from "../src/health/extensions";
import * as selection from "../src/health/selection";
import * as targets from "../src/command/kubernetes-target";

const results = [{ facetId: "status", description: "Status", entries: [] }];
const summarize: FacetSummarizeExtension = {
  id: "summary", kind: "facet.summarize", access: {}, facets: [{ id: "status", title: "Status", description: "Status" }],
  run: withSummary({ title: "Summary", fields: [] }, async () => results),
};
function service(name: string, extensions: ServiceDefinition["extensions"] = []): ServiceDefinition {
  return { name, aliases: [`${name}-alias`], workloads: [], extensions,
    component: { name, repository: { forge: { name: "fixture" }, path: `fixture/${name}` } } };
}
const plugin = { id: "fixture", version: "1", services: createServiceCatalog([
  service("api", [summarize, { ...summarize, namespace: "plugin/fixture" }]),
  service("worker", [summarize]), service("unrelated"),
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
  for (const services of [[], [service("unrelated")], [service("api", [{ ...summarize, namespace: "plugin/fixture" }])]]) {
    expect(() => healthProviders({ ...plugin, services: createServiceCatalog(services) })).toThrow("没有支持 health");
  }
});

test("interactive health preselects every candidate and respects the user's subset", async () => {
  const prompt = mock(async (input: { choices: readonly { name: string }[]; defaults?: readonly string[] }) => {
    expect(input.choices.map(choice => choice.name)).toEqual(["api", "worker"]);
    expect(input.defaults).toEqual(["api", "worker"]);
    return ["worker"];
  });
  const selected = await selection.selectHealthProviders(plugin, undefined, true, prompt);
  expect(selected?.map(provider => provider.name)).toEqual(["worker"]);
  expect(prompt).toHaveBeenCalledTimes(1);
});

test("explicit Services and noninteractive defaults skip prompting; cancellation does not default back to all", async () => {
  const prompt = mock(async () => undefined);
  expect((await selection.selectHealthProviders(plugin, ["worker-alias"], true, prompt))?.map(provider => provider.name)).toEqual(["worker"]);
  expect((await selection.selectHealthProviders(plugin, undefined, false, prompt))?.map(provider => provider.name)).toEqual(["api", "worker"]);
  expect(prompt).not.toHaveBeenCalled();
  expect(await selection.selectHealthProviders(plugin, undefined, true, prompt)).toBeUndefined();
  expect(await selection.selectHealthProviders(plugin, undefined, true, async () => [])).toBeUndefined();
});

test("cancelling Service selection stops health before environment preparation", async () => {
  const selected = spyOn(selection, "selectHealthProviders").mockResolvedValue(undefined);
  const context = new CommandContext({}, undefined, { plugin });
  const environment = mock(async () => {});
  context.ensureEnvironment = async requirements => { if (requirements.kubernetes) await environment(); };
  try {
    expect((await healthCommand.run(context, { since: "1h" })).status).toBe(CommandStatus.Cancelled);
    expect(environment).not.toHaveBeenCalled();
  } finally { selected.mockRestore(); await context.disposeClients(); }
});

test("noninteractive command runs all supported Services once, or only explicitly selected Services", async () => {
  const calls: string[] = [];
  const summary = { ...summarize, run: withSummary({ title: "Summary", fields: [] }, async context => {
    calls.push(context.target.service.name); return results;
  }) };
  const definition = { ...plugin, services: createServiceCatalog([
    service("api", [summary, { ...summary, namespace: "plugin/fixture" }]),
    service("worker", [summary]), service("unrelated"),
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
        const result = await healthCommand.run(context, { since: "1h", service, yes: true });
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
