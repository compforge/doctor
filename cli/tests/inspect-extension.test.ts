import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServiceCatalog, defineInspectProbeExtension, defineObservation } from "@compforge/doctor-plugin";
import * as contexts from "../src/plugin/context";
import { makeInspectProbes } from "../src/collect/inspect/probe";
import { makePluginInspectProbe } from "../src/collect/inspect/probe/plugin-inspect";
import { collectedFact, unavailableFact } from "../src/collect/protocol";
import { CommandContext } from "../src/command";
import { EvidenceBundle } from "../src/collect/evidence";
import type { InspectCommandContext, InspectFacts } from "../src/collect/inspect/model";
import { buildInspectHtmlSections, buildInspectSummary } from "../src/collect/inspect/render";

class Reading {
  constructor(readonly sample: string) {}
  summary() { return { title: "Provider reading", fields: [{ label: "Sample", path: ["sample"] }] }; }
}
const produces = defineObservation({ kind: "sample", schemaVersion: 1, codec: {
  encode: (value: Reading) => ({ sample: value.sample }),
  decode: (data: unknown) => { if (!data || typeof data !== "object" || !("sample" in data) || typeof data.sample !== "string") throw new Error("bad sample"); return new Reading(data.sample); },
} });
const facts: InspectFacts = {
  serviceTargets: collectedFact("inspect.service-targets", "service-targets", { services: {} }),
  deploymentConfiguration: unavailableFact("inspect.deployment-configuration", "service-targets", "not requested"),
  dependencyTargets: unavailableFact("inspect.dependency-targets", "service-targets", "not requested"),
  lifecycleSignals: unavailableFact("inspect.lifecycle-signals", "service-targets", "not requested"),
};

for (const status of ["ok", "partial", "unavailable"] as const) {
  test(`Service inspect extension runs once without a Workload and persists ${status} Value`, async () => {
    let calls = 0; let disposed = 0;
    const extension = defineInspectProbeExtension({ id: "reading", kind: "inspect.probe", access: {}, produces,
      run: async context => { calls++; context.onDispose(() => { disposed++; });
        return status === "ok" ? { status, value: new Reading("arm64") } : { status, reason: "one source unavailable", value: new Reading("arm64") }; },
    });
    const service = { name: "custom", component: { name: "app", repository: { forge: { name: "test" }, path: "app" } }, workloads: [], extensions: [extension] };
    const catalog = createServiceCatalog([service]);
    const managed = contexts.createPluginContext(undefined, { namespace: "demo" }, { environment: { kind: "host", name: "test" }, service, capability: extension });
    const opening = spyOn(contexts, "openPluginContext").mockResolvedValue(managed);
    const directory = mkdtempSync(join(tmpdir(), "inspect-extension-"));
    const command = new CommandContext({});
    const ctx: InspectCommandContext = {
      command, executor: {} as InspectCommandContext["executor"], resources: async () => { throw new Error("unexpected resource"); },
      exec: async () => { throw new Error("unexpected exec"); }, authorization: {} as InspectCommandContext["authorization"],
      config: { namespace: "demo", namespaceSource: "flag", services: ["custom"], servicesExplicit: true, format: "bundle", reportName: "inspect", profileName: "test", kube: { namespace: "demo" } },
      bundle: new EvidenceBundle(directory), log: () => {},
    };
    try {
      const scheduled = makeInspectProbes(facts, ctx.config, catalog, []);
      expect(scheduled.filter(item => item.id.startsWith("plugin-inspect"))).toHaveLength(1);
      expect(makeInspectProbes(facts, { ...ctx.config, field: "image" }, catalog, []).some(item => item.id.startsWith("plugin-inspect"))).toBe(false);
      expect(makeInspectProbes(facts, ctx.config, createServiceCatalog([{ ...service, extensions: [] }]), []).some(item => item.id.startsWith("plugin-inspect"))).toBe(false);
      const observations = await makePluginInspectProbe(service, extension, []).run(ctx, facts, ctx.config, []);
      expect(calls).toBe(1); expect(disposed).toBe(1);
      expect(observations).toMatchObject([{ kind: "plugin-inspect", status, value: { sample: "arm64" }, observationKind: "sample" }]);
      const diagnosis = { evidence: { facts, observations, rows: [] }, findings: [] };
      expect(buildInspectSummary(diagnosis)).toContain("arm64");
      expect(buildInspectHtmlSections(diagnosis).some(section => section.html.includes("arm64"))).toBe(true);
    } finally { opening.mockRestore(); await managed.dispose(); rmSync(directory, { recursive: true, force: true }); }
  });
}
