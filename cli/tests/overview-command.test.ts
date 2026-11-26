import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDoctorProgram } from "../src/app/main";
import * as execution from "../src/app/command";
import { CommandContext, CommandStatus } from "../src/command";
import { overviewCommand, type OverviewOutput } from "../src/overview";
import { buildOverviewHtml, writeOverviewEvidence } from "../src/overview/report";
import { captureSerializedDirectory, finalizeResult, readReport } from "./report-fixture";
import type { Manifest } from "../src/command/manifest";

test("overview is the sole CLI name and preserves lookup and explicit collection flags", async () => {
  const run = spyOn(execution, "runCommand").mockResolvedValue(undefined);
  try {
    const program = createDoctorProgram({ commands: "overview" });
    const command = program.commands.find(item => item.name() === "overview")!;
    expect(command).toBeDefined();
    expect(program.commands.some(item => item.name() === "sample" || item.aliases().includes("sample"))).toBe(false);
    expect(command.helpInformation()).toContain("--collect");
    program.exitOverride().configureOutput({ writeErr: () => {} });
    await expect(program.parseAsync(["sample"], { from: "user" })).rejects.toMatchObject({ code: "commander.unknownCommand" });
    expect(run).not.toHaveBeenCalled();
    expect(program.helpInformation()).toMatch(/\n\s+overview\s/);
    for (const collect of [false, true]) {
      await program.parseAsync(["overview", "--facet", "errors", "--since", "1h", "--sample-count", "3",
        ...(collect ? ["--collect"] : [])], { from: "user" });
      const [spec, opts] = run.mock.calls.at(-1)!;
      expect(spec).toBe(overviewCommand);
      expect(opts).toMatchObject({ facet: "errors", since: "1h", sampleCount: 3 });
      if (collect) expect(opts).toHaveProperty("collect", true);
      else expect(opts).not.toHaveProperty("collect", true);
    }
  } finally { run.mockRestore(); }
});

test("overview owns report titles, artifact identity and serialized manifest", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-overview-test-"));
  const context = new CommandContext({});
  const output: OverviewOutput = {
    query: { window: { from: "2026-10-09T00:00:00Z", to: "2026-10-09T01:00:00Z" }, maxEntries: 100 },
    providers: [], samples: [], sampleAllocations: [], collection: "not-requested",
  };
  const captured = captureSerializedDirectory();
  let evidence: string | undefined;
  try {
    evidence = writeOverviewEvidence(output, context);
    expect(context.artifacts.list().map(artifact => artifact.command)).toEqual(["overview"]);
    expect(buildOverviewHtml(output)).toContain("<title>Doctor Overview</title>");
    const result = { status: CommandStatus.Ok, output, artifacts: context.artifacts.list() };
    expect(overviewCommand.reportName?.({}, result, new Date())).toStartWith("doctor-overview-");
    const outputPath = join(root, "overview.html");
    expect(await finalizeResult(context, overviewCommand, result, { format: "html", output: outputPath }, {})).toBe(0);
    const directory = captured.directory!;
    const manifest: Manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.source.command).toBe("overview");
    const html = readFileSync(join(directory, manifest.files.report!.path), "utf8");
    expect(readFileSync(outputPath, "utf8")).toBe(html);
    expect(html).toContain("doctor overview");
    expect(readReport(html).pages).toContain("<title>Doctor Overview</title>");
  } finally {
    const directory = captured.directory;
    captured.restore();
    if (directory) rmSync(directory, { recursive: true, force: true });
    await context.disposeClients();
    if (evidence) rmSync(evidence, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
