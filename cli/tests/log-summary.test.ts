import { expect, spyOn, test } from "bun:test";
import { readFileSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { SerializeContext } from "../src/command/serialization/context";
import { collectedFact } from "../src/collect/protocol";
import type { DataOutput } from "../src/collect/data/model";
import { join } from "node:path";
import { createDoctorProgram } from "../src/app/main";
import { CommandContext, CommandStatus } from "../src/command";
import { logCommand } from "../src/collect/log/command";
import type { LogOutput } from "../src/collect/log";
import { logSummary } from "../src/collect/log/summary";
import { finalizeResult } from "./report-fixture";

test("log exposes summary and allows distributions to select it as default", () => {
  const program = createDoctorProgram({ commandDefaults: { log: { format: "summary" } } });
  const log = program.commands.find(command => command.name() === "log")!;
  const format = log.options.find(option => option.long === "--format")!;
  expect(format.argChoices).toContain("summary");
  expect(log.helpInformation()).toContain("summary");
});

for (const format of ["summary", "manifest"] as const) {
  test(`log ${format} retains every query while terminal summary is bounded`, async () => {
    const context = new CommandContext({});
    const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    const render = spyOn(logCommand, "render");
    let directory: string | undefined;
    try {
      const output: LogOutput = { namespace: "test", services: ["api"], items: Array.from({ length: 30 }, (_, i) => ({
        bizId: `request-${i}`, status: i ? CommandStatus.Ok : CommandStatus.Failed,
        ...(i ? {} : { reason: "trace resolution failed" }), artifacts: [],
      })) };
      const code = await finalizeResult(context, logCommand, {
        status: CommandStatus.Partial, output, summary: logSummary(output), artifacts: [],
      }, { format });
      expect(render).not.toHaveBeenCalled();
      const terminal = stdout.mock.calls.map(([line]) => String(line)).join("");
      if (format === "summary") {
        directory = stderr.mock.calls.map(([line]) => String(line))
          .find(line => line.startsWith("[delivery] Evidence: "))?.trim().slice("[delivery] Evidence: ".length);
        expect(terminal).toContain("trace resolution failed");
        expect(terminal).toContain("见原始数据");
        expect(terminal).not.toContain("request-29");
        expect(terminal.length).toBeLessThan(3000);
      } else {
        const manifest = JSON.parse(terminal);
        directory = manifest.delivery.location.directory;
        expect(manifest.execution.status).toBe("partial");
        expect(manifest.delivery.exitCode).toBe(code);
      }
      expect(directory).toBeDefined();
      expect(JSON.parse(readFileSync(join(directory!, "output.json"), "utf8"))).toEqual(output);
      const manifest = JSON.parse(readFileSync(join(directory!, "manifest.json"), "utf8"));
      expect(manifest.serialization.status).toBe("ok");
      expect(manifest.delivery.status).toBe("ok");
    } finally {
      render.mockRestore(); stdout.mockRestore(); stderr.mockRestore();
      await context.disposeClients();
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });
}


test("Log root surfaces producer Data text and navigates directly to its Fact evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-log-text-"));
  const context = new CommandContext({});
  try {
    const facts = { services: {}, capabilityResults: [{
      id: "q1", stage: "provide" as const, service: "sample", identity: { kind: "biz_id", value: "s1" },
      ...collectedFact("data.inspect-result", "test", { result: {
        resolution: { inputId: "s1", resolvedAs: "run_id", identifiers: { run_id: "s1" } },
        facts: [{ factType: "record" as const, kind: "run", schemaVersion: 1, recordKey: "s1",
          record: { ready: true, observation: null },
          summary: { title: "Run", text: "Carrier Ready; Sandbox observation absent", fields: [] } }],
      } }),
    }] };
    writeFileSync(join(root, "facts.json"), JSON.stringify(facts));
    writeFileSync(join(root, "collection.json"), JSON.stringify({ files: { facts: "facts.json" } }));
    const artifact = context.artifacts.add({ command: "data", path: root });
    const data: DataOutput = { items: [{ bizId: "s1", status: CommandStatus.Ok, artifacts: [artifact],
      diagnosis: { evidence: { facts, observations: [] }, findings: [], coverage: [] } }] };
    const output: LogOutput = { namespace: "test", services: ["sample"], items: [],
      identityResolution: { status: CommandStatus.Ok, output: data, artifacts: [artifact] } };
    const directory = join(root, "delivered");
    await SerializeContext.create(directory, logCommand, {
      status: CommandStatus.Ok, output, summary: logSummary(output), artifacts: [],
    });
    const text = readFileSync(join(directory, "summary.md"), "utf8");
    expect(text).toContain("Carrier Ready; Sandbox observation absent");
    expect(text).toContain("capabilityResults.0.result.facts.0");
    const path = /\[facts\]\(<([^>]+)>\)/.exec(text)![1]!;
    const stored = JSON.parse(readFileSync(join(directory, path), "utf8"));
    expect(stored.capabilityResults[0].result.facts[0].record).toEqual({ ready: true, observation: null });
    const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
    expect(manifest.serialization.status).toBe("ok");
  } finally { await context.disposeClients(); rmSync(root, { recursive: true, force: true }); }
});
