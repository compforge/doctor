import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServiceCatalog, type PluginDefinition } from "@compforge/doctor-plugin";
import { CommandContext, CommandStatus, defineCommand, type CommandInput, type CommandSpec } from "../src/command";
import { collectOverviewSamples } from "../src/overview/collect";
import { COLLECT_KINDS, resolveCollectKinds, type CollectKind } from "../src/collect/composite";
import { inspectCommand } from "../src/collect/inspect/command";
import { tenantCommand } from "../src/collect/tenant/command";
import { dataCommand } from "../src/collect/data/command";
import { traceCommand } from "../src/collect/trace/command";
import { logCommand } from "../src/collect/log/command";
import { metricCommand } from "../src/collect/metric/command";
import { deliverCommandArtifacts } from "../src/app/delivery";

// Keep the real Overview -> Collect delegation and CommandSpec wrappers; only replace external work.
test("overview collects all selected kinds, shares Inspect/Tenant evidence, and honors default log Services", async () => {
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
  function replace<Input extends CommandInput>(command: CommandSpec<Input, void>, kind: CollectKind, check?: (input: Input) => void) {
    const replacement = defineCommand<Input, void>({ name: command.name, run: async (ctx, input) => {
      check?.(input);
      calls[kind] = (calls[kind] ?? 0) + 1;
      const path = join(root, `${kind}-${calls[kind]}`);
      mkdirSync(path);
      writeFileSync(join(path, "report.html"), `<html><body>${kind} evidence ${calls[kind]}</body></html>`);
      ctx.artifacts.add(kind, path);
      await Bun.sleep(2);
      return { status: kind === "tenant" ? CommandStatus.Partial : CommandStatus.Ok, output: undefined, artifacts: [] };
    } });
    const spy = spyOn(command, "run").mockImplementation(replacement.run);
    restore.push(() => spy.mockRestore());
  }
  replace(inspectCommand, "inspect");
  replace(tenantCommand, "tenant");
  replace(dataCommand, "data");
  replace(traceCommand, "trace");
  replace(logCommand, "log", (input) => expect(input.services).toBe("chat-server"));
  replace(metricCommand, "metric");
  try {
    const kinds = await resolveCollectKinds(undefined, false);
    expect(kinds).toEqual([...COLLECT_KINDS]);
    const result = await collectOverviewSamples(context, ["a", "b", "c", "d", "e"], {
      kinds: kinds!, namespace: "ns", tenantId: "tenant-one",
    }, 2);
    expect(result.status).toBe(CommandStatus.Partial);
    expect(calls).toEqual({ inspect: 1, tenant: 1, data: 5, trace: 5, log: 5, metric: 5 });
    for (const command of ["inspect", "tenant"]) expect(result.artifacts.filter((artifact) => artifact.command === command)).toHaveLength(1);
    const manifests = result.artifacts.filter((artifact) => artifact.command === "collect");
    expect(manifests).toHaveLength(5);
    for (const artifact of manifests) {
      const manifest = JSON.parse(readFileSync(artifact.path, "utf8"));
      expect(manifest.steps.map((step: { id: string }) => step.id)).toEqual([...COLLECT_KINDS]);
      expect(manifest.steps.find((step: { id: string }) => step.id === "tenant").status).toBe("partial");
    }
    const output = join(root, "overview.html");
    expect(await deliverCommandArtifacts(context, { output, format: "html" }, 0, "doctor overview")).toBeTrue();
    const html = readFileSync(output, "utf8");
    const reports: Record<string, string> = JSON.parse(html.match(/const reports=(.*);/)![1]!);
    for (const kind of ["inspect", "tenant"]) {
      expect(html).toContain(`data-kind="${kind}"`);
      expect(Object.keys(reports).filter((key) => key.startsWith(kind))).toEqual([kind]);
      expect(Buffer.from(reports[kind]!, "base64").toString()).toContain(`${kind} evidence 1`);
    }
  } finally {
    for (const undo of restore) undo();
    for (const artifact of context.artifacts.list()) if (artifact.command === "collect") rmSync(dirname(artifact.path), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
