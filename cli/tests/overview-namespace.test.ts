import { expect, mock, spyOn, test } from "bun:test";
import {
  createServiceCatalog, withSummary, type PluginDefinition, type ServiceDefinition,
  type OverviewSummarizeExtension, type OverviewSampleExtension,
} from "@compforge/doctor-plugin";
import { overviewProviders } from "../src/overview/extensions";
import { overviewCommand, validateOverviewOptions } from "../src/overview";
import { overviewServiceNames } from "../src/overview/options";
import { runOverviewSession } from "../src/overview/flow";
import { buildOverviewHtml } from "../src/overview/report";
import { CommandContext, CommandStatus } from "../src/command";
import { createDoctorProgram } from "../src/app/main";

const facet = { id: "errors", title: "Errors", description: "Recorded errors" };
const summarize: OverviewSummarizeExtension = {
  id: "summary", kind: "overview.summarize", facets: [facet], access: {},
  run: withSummary({ title: "Errors", fields: [] }, async () => []),
};
const sample: OverviewSampleExtension = {
  id: "sample", kind: "overview.sample", access: {},
  run: withSummary({ title: "Samples", fields: [] }, async () => []),
};
const service = (name: string, extensions: ServiceDefinition["extensions"] = []): ServiceDefinition => ({
  name, aliases: name === "api" ? ["short"] : [], workloads: [], extensions,
  component: { name, repository: { forge: { name: "fixture" }, path: `fixture/${name}` } },
});
function plugin(product: readonly (OverviewSummarizeExtension | OverviewSampleExtension)[] = [{ ...summarize, namespace: "plugin/fixture" }]): PluginDefinition {
  return { id: "fixture", version: "1",
    services: createServiceCatalog([service("api", [summarize, sample, ...product]), service("store")]) };
}

test("a Service can provide the product namespace while retaining its own context binding", () => {
  const run = mock(async () => []);
  const definition = plugin([{ ...summarize, namespace: "plugin/fixture", run: withSummary({ title: "Errors", fields: [] }, run) }]);
  const selected = overviewProviders(definition);
  expect(selected).toHaveLength(1);
  expect(selected[0]?.namespace).toBe("plugin/fixture");
  expect(selected[0]?.service.name).toBe("api");
  // A Service-scoped sample must not be borrowed by a product-scoped summary from the same provider.
  expect(selected[0]?.sample).toBeUndefined();
  expect(run).not.toHaveBeenCalled();
});

test("explicit Service selection resolves aliases without validating operations in another namespace", () => {
  const selected = overviewProviders(plugin([{ ...summarize, namespace: "plugin/fixture", facets: [] }]), ["short", "api"]);
  expect(selected).toHaveLength(1);
  expect(selected[0]?.namespace).toBe("plugin/fixture/service/api");
  expect(selected[0]?.summarize).toBe(summarize);
  expect(selected[0]?.sample).toBe(sample);
  expect(selected[0]?.sampleService?.name).toBe("api");
  expect(() => overviewProviders(plugin(), ["missing"])).toThrow("Unknown Service");
  expect(() => overviewProviders(plugin(), ["store"])).toThrow("overview.summarize");
  expect(() => overviewProviders(plugin(), [])).toThrow("empty");
});

test("selection follows the declared namespace even when another Service provides it", () => {
  const definition = { id: "fixture", version: "1", services: createServiceCatalog([
    service("api"), service("store", [{ ...summarize, namespace: "plugin/fixture/service/api" }]),
  ]) };
  const selected = overviewProviders(definition, ["short"])[0]!;
  expect(selected.namespace).toBe("plugin/fixture/service/api");
  expect(selected.service.name).toBe("store");
});

test("missing or ambiguous product operations fail instead of aggregating service namespaces", () => {
  expect(() => overviewProviders(plugin([]))).toThrow("--service");
  expect(() => overviewProviders(plugin([
    { ...summarize, namespace: "plugin/fixture" }, { ...summarize, id: "second", namespace: "plugin/fixture" },
  ]))).toThrow("ambiguous");
  expect(() => overviewProviders({ ...plugin([]), extensions: [summarize] })).toThrow("providing Service");
});

test("summary and sample in one namespace can have different providing Services and access", () => {
  const sampleAccess = { kubernetes: [{ requirement: "required" as const,
    purpose: "Read sampling configuration", rule: { verb: "get", resource: "configmaps" } }] };
  const selected = overviewProviders({ id: "fixture", version: "1", services: createServiceCatalog([
    service("api", [{ ...summarize, namespace: "plugin/fixture" }]),
    service("store", [{ ...sample, namespace: "plugin/fixture", access: sampleAccess }]),
  ]) })[0]!;
  expect(selected.service.name).toBe("api");
  expect(selected.sampleService?.name).toBe("store");
  expect(selected.summarize.access).toEqual({});
  expect(selected.sample?.access).toEqual(sampleAccess);
});

test("Overview rejects invalid selection before Kubernetes preparation", async () => {
  for (const [definition, input, reason] of [
    [plugin([]), {}, "--service"],
    [plugin(), { service: "store" }, "overview.summarize"],
    [plugin(), { facet: "missing" }, "Facet"],
  ] as const) {
    const context = new CommandContext({}, undefined, { plugin: definition });
    const accesses = mock(async () => { throw new Error("unexpected environment access"); });
    context.ensureEnvironment = async requirements => { if (requirements.kubernetes) await accesses(); };
    try {
      const result = await overviewCommand.run(context, { since: "1h", ...input });
      expect(result.status).toBe(CommandStatus.Failed);
      expect("reason" in result ? result.reason : undefined).toContain(reason);
      expect(accesses).not.toHaveBeenCalled();
    } finally { await context.disposeClients(); }
  }
});

test("CLI exposes explicit Service selection and rejects conflicting or empty selectors", () => {
  const command = createDoctorProgram().commands.find(command => command.name() === "overview")!;
  expect(command.helpInformation()).toContain("--service <name>");
  expect(overviewServiceNames({})).toBeUndefined();
  expect(overviewServiceNames({ service: "short" })).toEqual(["short"]);
  expect(overviewServiceNames({ services: "api, store" })).toEqual(["api", "store"]);
  for (const opts of [{ service: "" }, { service: "api,store" }, { services: "api,,store" }, { service: "api", services: "store" }]) {
    expect(() => validateOverviewOptions(opts)).toThrow("--service");
  }
});

test("same display names retain distinct namespace provenance through sampling and reports", async () => {
  const definition = { id: "api", version: "1", services: createServiceCatalog([service("api", [
    summarize, sample, { ...summarize, namespace: "plugin/api" }, { ...sample, namespace: "plugin/api" },
  ])]) };
  const providers = [...overviewProviders(definition), ...overviewProviders(definition, ["api"])];
  const result = await runOverviewSession(providers, { window: { from: "2026-09-27T00:00:00Z", to: "2026-09-27T01:00:00Z" }, maxEntries: 10 }, {
    summarize: async () => [{ facetId: "errors", description: "fixture errors", entries: [{ key: "E1", label: "E1", data: 1, canSample: true }] }],
    sample: async provider => [{ bizId: provider.namespace === "plugin/api" ? "product-trace" : "service-trace" }],
    select: async () => "errors", collect: async () => ({ status: CommandStatus.Ok, output: undefined, artifacts: [] }), show: () => {},
  });
  expect(result.providers.map(item => item.namespace)).toEqual(["plugin/api", "plugin/api/service/api"]);
  expect(result.samples.map(item => [item.namespace, item.bizId])).toEqual([
    ["plugin/api", "product-trace"], ["plugin/api/service/api", "service-trace"],
  ]);
  const sections = buildOverviewHtml(result).split("<h2>api</h2>");
  expect(sections[1]).toContain("product-trace");
  expect(sections[1]).not.toContain("service-trace");
  expect(sections[2]).toContain("service-trace");
  expect(sections[2]).not.toContain("product-trace");
});

test("Overview command invokes the namespace provider using its original Service context", async () => {
  const targets = await import("../src/command/kubernetes-target");
  const { rmSync } = await import("node:fs");
  const calls: string[] = [];
  const summary = (owner: string, expectedService: string, namespace?: string): OverviewSummarizeExtension => ({
    ...summarize, namespace,
    run: withSummary({ title: "Errors", fields: [] }, async context => {
      expect(context.target.service.name).toBe(expectedService);
      calls.push(owner);
      return [{ facetId: "errors", description: "fixture", entries: [] }];
    }),
  });
  const definition: PluginDefinition = {
    id: "fixture", version: "1", services: createServiceCatalog([
      service("api", [summary("service", "api")]),
      service("store", [summary("product", "store", "plugin/fixture")]),
    ]),
  };
  const config = spyOn(targets, "resolveKubernetesCommandConfig").mockResolvedValue({
    profileName: "fixture", kubernetes: { namespace: "test", namespaceSource: "flag", kubeconfigSource: "flag" },
  });
  const executor = spyOn(targets, "createKubernetesExecutor").mockReturnValue({
    run: async args => {
      if (args[0] !== "config") throw new Error(`unexpected I/O: ${args.join(" ")}`);
      return { ok: true, stdout: "fixture\nhttps://cluster.example", stderr: "", exitCode: 0,
        command: args, durationMs: 1, timedOut: false };
    },
    exec: async () => { throw new Error("unexpected exec"); },
  });
  try {
    for (const selection of [undefined, "short"]) {
      const context = new CommandContext({}, undefined, { plugin: definition });
      context.ensureEnvironment = async () => {};
      try {
        const result = await overviewCommand.run(context, { since: "1h", service: selection });
        expect(result.status).toBe(CommandStatus.Ok);
        expect(result.output?.providers.map(provider => provider.namespace)).toEqual([
          selection ? "plugin/fixture/service/api" : "plugin/fixture",
        ]);
      } finally {
        await context.disposeClients();
        for (const artifact of context.artifacts.list()) rmSync(artifact.path, { recursive: true, force: true });
      }
    }
    expect(calls).toEqual(["product", "service"]);
  } finally { executor.mockRestore(); config.mockRestore(); }
});
