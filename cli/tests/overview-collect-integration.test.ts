import { createServiceCatalog, type PluginDefinition } from "@compforge/doctor-plugin";
import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deliverCommandArtifacts } from "../src/app/delivery";
import { COLLECT_KINDS, collectCommand, resolveCollectKinds, type CollectKind } from "../src/collect/composite";
import { dataCommand } from "../src/collect/data/command";
import { inspectCommand } from "../src/collect/inspect/command";
import { logCommand } from "../src/collect/log/command";
import { metricCommand } from "../src/collect/metric/command";
import { tenantCommand } from "../src/collect/tenant/command";
import { traceCommand } from "../src/collect/trace/command";
import { CommandContext, CommandStatus, defineCommand, type CommandInput, type CommandSpec } from "../src/command";
import { collectOverviewSamples } from "../src/overview/collect";
import { readBundleIndex, readBundleText } from "./bundle-fixture";
import { fixtureReport, readReport, renderForDelivery } from "./report-fixture";

// Keep the real Overview -> Collect delegation and CommandSpec wrappers; only replace external work.
test.each([1, 2])("overview with collect concurrency %i delivers same-named artifacts and shared Inspect/Tenant evidence", async concurrency => {
  const root = mkdtempSync(join(tmpdir(), "doctor-overview-idempotency-"));
  const calls: Record<string, number> = {};
  const plugin: PluginDefinition = {
    id: "test", version: "1.0.0",
    services: createServiceCatalog(["chat-server", "asclaw-server", "canvas-server"].map((name) => ({
      name, workloads: [], capabilities: { log: { default: name === "chat-server" } },
    }))),
  };
  const context = new CommandContext({}, undefined, { plugin });
  const restore: Array<() => void> = [];
  function replace<Input extends CommandInput>(command: CommandSpec<Input, unknown>, kind: CollectKind, check?: (input: Input) => void) {
    const replacement = defineCommand<Input, void>({ name: command.name, run: async (ctx, input) => {
      check?.(input);
      calls[kind] = (calls[kind] ?? 0) + 1;
      const path = join(root, `${kind}-${calls[kind]}`, `doctor-${kind}-same-second`);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, "report.html"), `<html><body>${kind} evidence ${calls[kind]}</body></html>`);
      ctx.artifacts.add({ command: kind, path });
      await Bun.sleep(2);
      return { status: kind === "tenant" ? CommandStatus.Partial : CommandStatus.Ok, output: undefined, artifacts: [] };
    } });
    const spy = spyOn(command, "run").mockImplementation(replacement.run);
    const renderSpy = spyOn(command, "render").mockImplementation(async (_renderer, result) => {
      const rendered = fixtureReport(context).report;
      return { ...rendered, sections: rendered.sections.filter(section => section.id === kind).map(section => ({ ...section, status: result.status })) };
    });
    restore.push(() => { spy.mockRestore(); renderSpy.mockRestore(); });
  }
  replace(inspectCommand, "inspect");
  replace(tenantCommand, "tenant");
  replace(dataCommand, "data", input => expect(input.bizIds).toEqual(["a", "b", "c", "d", "e"]));
  replace(traceCommand, "trace");
  replace(logCommand, "log", (input) => expect(input.services).toBe("chat-server"));
  replace(metricCommand, "metric");
  try {
    const kinds = await resolveCollectKinds(undefined, false);
    expect(kinds).toEqual([...COLLECT_KINDS]);
    const result = await collectOverviewSamples(context, ["a", "b", "c", "d", "e"], {
      kinds: kinds!, namespace: "ns", tenantId: "tenant-one",
    }, concurrency);
    expect(result.status).toBe(CommandStatus.Partial);
    expect(calls).toEqual({ inspect: 1, tenant: 1, data: 1, trace: 1, log: 1, metric: 1 });
    for (const command of ["inspect", "tenant"]) expect(result.artifacts.filter((artifact) => artifact.command === command)).toHaveLength(1);
    const manifests = result.artifacts.filter((artifact) => artifact.command === "collect");
    expect(manifests).toHaveLength(1);
    for (const artifact of manifests) {
      const manifest = JSON.parse(readFileSync(artifact.path, "utf8"));
      expect(manifest.steps.map((step: { id: string }) => step.id)).toEqual([...COLLECT_KINDS]);
      expect(manifest.steps.find((step: { id: string }) => step.id === "tenant").status).toBe("partial");
    }
    const output = join(root, "overview.html");
    expect(await deliverCommandArtifacts(context, { output }, 0, "doctor overview", await renderForDelivery(context, collectCommand, result))).toBeTrue();
    const archive = join(root, "overview.tar.gz");
    const index = readBundleIndex(archive, "overview");
    expect(index.artifacts).toHaveLength(result.artifacts.length);
    expect(new Set(index.artifacts.map(artifact => artifact.id)).size).toBe(index.artifacts.length);
    expect(new Set(index.artifacts.map(artifact => artifact.path)).size).toBe(index.artifacts.length);
    for (const kind of ["inspect", "tenant"]) expect(index.artifacts.filter(artifact => artifact.command === kind)).toHaveLength(1);
    const collectManifests = index.artifacts.filter(artifact => artifact.command === "collect");
    expect(collectManifests).toHaveLength(1);
    const bizIds: string[] = [];
    const referencedData = new Set<string>();
    for (const artifact of collectManifests) {
      const manifest = JSON.parse(readBundleText(archive, `overview/${artifact.path}`));
      expect(manifest.schema_version).toBe(3);
      bizIds.push(...manifest.target.biz_ids);
      for (const step of manifest.steps) {
        expect(step.artifact_ids).toHaveLength(1);
        const evidence = index.artifacts.find(artifact => artifact.id === step.artifact_ids[0])!;
        expect(evidence.command).toBe(step.id);
        expect(readBundleText(archive, `overview/${evidence.report}`)).toContain(`${step.id} evidence`);
        if (step.id === "data") referencedData.add(evidence.id);
      }
    }
    expect(bizIds.sort()).toEqual(["a", "b", "c", "d", "e"]);
    expect(referencedData.size).toBe(1);
    const agents = readBundleText(archive, "overview/AGENTS.md");
    for (const artifact of index.artifacts) if (artifact.report) expect(agents).toContain(artifact.report);
    const html = readFileSync(output, "utf8");
    const report = readReport(html);
    for (const kind of ["inspect", "tenant"]) {
      expect(report.index.sections.filter(section => section.id === kind)).toHaveLength(1);
      expect(Buffer.from(report.entries[report.index.sections.find(section => section.id === kind)!.pages[0]!.entry!]!).toString()).toContain(`${kind} evidence 1`);
    }
  } finally {
    for (const undo of restore) undo();
    for (const artifact of context.artifacts.list()) if (artifact.command === "collect") rmSync(dirname(artifact.path), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
