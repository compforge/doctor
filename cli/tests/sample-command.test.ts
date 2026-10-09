import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDoctorProgram } from "../src/app/main";
import * as execution from "../src/app/command";
import { CommandContext, CommandStatus } from "../src/command";
import { sampleCommand, type SampleOutput } from "../src/overview";
import { buildOverviewHtml, writeOverviewEvidence } from "../src/overview/report";
import { finalizeResult, readReport } from "./report-fixture";
import { readBundleIndex, readBundleText } from "./bundle-fixture";

test("sample is the sole CLI name and preserves lookup and explicit collection flags", async () => {
  const run = spyOn(execution, "runCommand").mockResolvedValue(undefined);
  try {
    const program = createDoctorProgram({ commands: "sample" });
    const command = program.commands.find(item => item.name() === "sample")!;
    expect(command).toBeDefined();
    expect(program.commands.some(item => item.name() === "overview" || item.aliases().includes("overview"))).toBe(false);
    expect(command.helpInformation()).toContain("--collect");
    expect(program.helpInformation()).toMatch(/\n\s+sample\s/);
    for (const collect of [false, true]) {
      await program.parseAsync(["sample", "--facet", "errors", "--since", "1h", "--sample-count", "3",
        ...(collect ? ["--collect"] : [])], { from: "user" });
      const [spec, opts] = run.mock.calls.at(-1)!;
      expect(spec).toBe(sampleCommand);
      expect(opts).toMatchObject({ facet: "errors", since: "1h", sampleCount: 3 });
      if (collect) expect(opts).toHaveProperty("collect", true);
      else expect(opts).not.toHaveProperty("collect", true);
    }
  } finally { run.mockRestore(); }
});

test("sample owns report titles, artifact identity and bundle manifest", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-sample-test-"));
  const context = new CommandContext({});
  const output: SampleOutput = {
    query: { window: { from: "2026-10-09T00:00:00Z", to: "2026-10-09T01:00:00Z" }, maxEntries: 100 },
    providers: [], samples: [], sampleAllocations: [], collection: "not-requested",
  };
  let evidence: string | undefined;
  try {
    evidence = writeOverviewEvidence(output, context);
    expect(context.artifacts.list().map(artifact => artifact.command)).toEqual(["sample"]);
    expect(buildOverviewHtml(output)).toContain("<title>Doctor Sample</title>");
    const result = { status: CommandStatus.Ok, output, artifacts: context.artifacts.list() };
    expect(sampleCommand.reportName?.({}, result, new Date())).toStartWith("doctor-sample-");
    const archive = join(root, "sample.tar.gz");
    expect(await finalizeResult(context, sampleCommand, result, { format: "bundle", output: archive }, {})).toBe(0);
    const manifest = readBundleIndex(archive, "sample");
    expect(manifest.source.command).toBe("sample");
    const html = readBundleText(archive, `sample/${manifest.files.report!.path}`);
    expect(html).toContain("doctor sample");
    expect(readReport(html).pages).toContain("<title>Doctor Sample</title>");
  } finally {
    await context.disposeClients();
    if (evidence) rmSync(evidence, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
