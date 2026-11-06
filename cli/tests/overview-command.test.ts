import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDoctorProgram } from "../src/app/main";
import * as execution from "../src/app/command";
import { CommandContext, CommandStatus } from "../src/command";
import { overviewCommand, type OverviewOutput } from "../src/overview";
import { buildOverviewHtml, writeOverviewEvidence } from "../src/overview/report";
import { finalizeResult, readReport } from "./report-fixture";
import { readBundleIndex, readBundleText } from "./bundle-fixture";

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

test("overview owns report titles, artifact identity and bundle manifest", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-overview-test-"));
  const context = new CommandContext({});
  const output: OverviewOutput = {
    query: { window: { from: "2026-10-09T00:00:00Z", to: "2026-10-09T01:00:00Z" }, maxEntries: 100 },
    providers: [], samples: [], sampleAllocations: [], collection: "not-requested",
  };
  let evidence: string | undefined;
  try {
    evidence = writeOverviewEvidence(output, context);
    expect(context.artifacts.list().map(artifact => artifact.command)).toEqual(["overview"]);
    expect(buildOverviewHtml(output)).toContain("<title>Doctor Overview</title>");
    const result = { status: CommandStatus.Ok, output, artifacts: context.artifacts.list() };
    expect(overviewCommand.reportName?.({}, result, new Date())).toStartWith("doctor-overview-");
    const archive = join(root, "overview.tar.gz");
    expect(await finalizeResult(context, overviewCommand, result, { format: "bundle", output: archive }, {})).toBe(0);
    const manifest = readBundleIndex(archive, "overview");
    expect(manifest.source.command).toBe("overview");
    const html = readBundleText(archive, `overview/${manifest.files.report!.path}`);
    expect(html).toContain("doctor overview");
    expect(readReport(html).pages).toContain("<title>Doctor Overview</title>");
  } finally {
    await context.disposeClients();
    if (evidence) rmSync(evidence, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
