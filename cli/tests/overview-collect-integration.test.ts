import { createServiceCatalog, type PluginDefinition } from "@compforge/doctor-plugin";
import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { finalizeResult } from "./report-fixture";
import { serializeEvidenceResult } from "../src/collect/serialize";
import { COLLECT_KINDS, collectCommand, resolveCollectKinds, type CollectKind } from "../src/collect/composite";
import { dataCommand } from "../src/collect/data/command";
import { inspectCommand } from "../src/collect/inspect/command";
import { logCommand } from "../src/collect/log/command";
import { metricCommand } from "../src/collect/metric/command";
import { tenantCommand } from "../src/collect/tenant/command";
import { traceCommand } from "../src/collect/trace/command";
import { CommandContext, CommandStatus, defineCommand, type CommandInput, type Command } from "../src/command";
import { collectOverviewSamples } from "../src/overview/collect";
import { readBundleIndex, readBundleText, readBundleExecutions } from "./bundle-fixture";
import { fixtureReport, readReport } from "./report-fixture";

// Keep the real Overview -> Collect delegation and Command wrappers; only replace external work.
test.each([1, 2])("overview with collect concurrency %i delivers same-named artifacts and shared Inspect/Tenant evidence", async concurrency => {
  const root = mkdtempSync(join(tmpdir(), "doctor-overview-idempotency-"));
  const calls: Record<string, number> = {};
  const plugin: PluginDefinition = {
    id: "test", version: "1.0.0",
    services: createServiceCatalog(["chat-server", "asclaw-server", "canvas-server"].map((name) => ({
      component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
      name,
      workloads: [],
      logs: { default: name === "chat-server" }
    }))),
  };
  const context = new CommandContext({}, undefined, { plugin });
  const restore: Array<() => void> = [];
  function replace<Input extends CommandInput>(command: Command<Input, unknown>, kind: CollectKind, check?: (input: Input) => void) {
    const replacement = defineCommand<Input, void>({
      name: command.name, prepare: async (_context, input) => input, run: async (ctx, input) => {
        check?.(input);
        calls[kind] = (calls[kind] ?? 0) + 1;
        const path = join(root, `${kind}-${calls[kind]}`, `doctor-${kind}-same-second`);
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, "report.html"), `<html><body>${kind} evidence ${calls[kind]}</body></html>`);
        ctx.artifacts.add({ command: kind, path });
        await Bun.sleep(2);
        return { status: kind === "tenant" ? CommandStatus.Partial : CommandStatus.Ok, output: undefined, artifacts: [] };
      }
    });
    const spy = spyOn(command, "run").mockImplementation(replacement.run);
    const serializeSpy = spyOn(command, "serialize").mockImplementation(serializeEvidenceResult);
    const renderSpy = spyOn(command, "render").mockImplementation(async (_renderer, result) => {
      const rendered = fixtureReport(context).report;
      return { ...rendered, sections: rendered.sections.filter(section => section.id === kind).map(section => ({ ...section, status: result.status })) };
    });
    restore.push(() => { spy.mockRestore(); renderSpy.mockRestore(); serializeSpy.mockRestore(); });
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
    expect(await finalizeResult(context, collectCommand, result, { output })).toBe(0);
    const archive = join(root, "overview.tar.gz");
    const index = readBundleIndex(archive, "overview");
    expect(index.command).toBe("collect");
    const executions = readBundleExecutions(archive, "overview");
    expect(executions).toHaveLength(COLLECT_KINDS.length + 1);
    expect(new Set(executions.map(entry => entry.manifest.executionId)).size).toBe(executions.length);
    expect(new Set(executions.map(entry => entry.path)).size).toBe(executions.length);
    for (const kind of ["inspect", "tenant", "data"]) expect(executions.filter(entry => entry.manifest.command === kind)).toHaveLength(1);
    const manifest = JSON.parse(readBundleText(archive, "overview/manifest.json"));
    expect(manifest.target.biz_ids).toEqual(["a", "b", "c", "d", "e"]);
    const diagnosis = JSON.parse(readBundleText(archive, `overview/${manifest.files.diagnosis.path}`));
    expect(diagnosis.steps.map((step: { kind: string }) => step.kind)).toEqual([...COLLECT_KINDS]);
    for (const step of diagnosis.steps) {
      const evidence = executions.find(entry => entry.manifest.executionId === step.result.executionId)!;
      expect(evidence.manifest.command).toBe(step.kind);
      expect(step.result.manifest).toBe(evidence.path);
      expect(readBundleText(archive, `overview/${join(dirname(evidence.path), evidence.manifest.files.report!.path)}`)).toContain(`${step.kind} evidence`);
    }
    const agents = readBundleText(archive, "overview/AGENTS.md");
    expect(agents).toContain("children");
    expect(agents).toContain("`report.html`");
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
