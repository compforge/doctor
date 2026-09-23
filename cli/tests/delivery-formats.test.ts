import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CommandContext } from "../src/command";
import { finalizeFixture, finalizeResult } from "./report-fixture";
import { inspectCommand } from "../src/collect/inspect/command";
import { CommandStatus } from "../src/command";

for (const format of ["json", "md"] as const) {
  test(`${format} retains distinct artifacts with the same command and deduplicates shared references`, async () => {
    const root = mkdtempSync(join(tmpdir(), "doctor-delivery-format-"));
    const context = new CommandContext({});
    try {
      for (const bizId of ["request-a", "request-b"]) {
        const path = join(root, bizId); mkdirSync(path);
        writeFileSync(join(path, "diagnosis.json"), JSON.stringify({ bizId }));
        writeFileSync(join(path, "summary.md"), `Evidence for ${bizId}`);
        const artifact = context.artifacts.add({ command: "log", path });
        context.artifacts.add(artifact);
      }
      const output = join(root, `report.${format}`);
      expect(await finalizeFixture(context, { format, output }, 0, "doctor overview")).toBe(0);
      const rendered = readFileSync(output, "utf8");
      const manifestPath = format === "json" ? JSON.parse(rendered).manifest : rendered.match(/\[完整执行结果\]\((.+)\)/)![1];
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      expect(manifest.children).toHaveLength(2);
      expect(new Set(manifest.children.map((child: { executionId: string }) => child.executionId)).size).toBe(2);
      const diagnoses = manifest.children.map((child: { manifest: string }) => {
        const childPath = join(dirname(manifestPath), child.manifest);
        const childManifest = JSON.parse(readFileSync(childPath, "utf8"));
        expect(childManifest.command).toBe("log");
        return JSON.parse(readFileSync(join(dirname(childPath), childManifest.files["diagnosis.json"].path), "utf8"));
      });
      expect(diagnoses).toEqual([{ bizId: "request-a" }, { bizId: "request-b" }]);

    } finally { await context.disposeClients(); rmSync(root, { recursive: true, force: true }); }
  });
}

test("single JSON export carries the domain diagnosis and its evidence manifest", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-delivery-single-"));
  const context = new CommandContext({});
  try {
    const source = join(root, "source"); mkdirSync(source);
    writeFileSync(join(source, "diagnosis.json"), '{"facts":[1]}');
    context.artifacts.add({ command: "log", path: source });
    const output = join(root, "report.json");
    expect(await finalizeFixture(context, { format: "json", output }, 0, "doctor log")).toBe(0);
    const exported = JSON.parse(readFileSync(output, "utf8"));
    expect(exported.result).toEqual({ facts: [1] });
    expect(JSON.parse(readFileSync(exported.manifest, "utf8")).children).toEqual([]);
  } finally { await context.disposeClients(); rmSync(root, { recursive: true, force: true }); }
});

test("summary finalization serializes evidence and skips the HTML renderer", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-delivery-summary-"));
  const context = new CommandContext({});
  const output = spyOn(process.stdout, "write").mockImplementation(() => true);
  const evidenceOutput = spyOn(process.stderr, "write").mockImplementation(() => true);
  const render = spyOn(inspectCommand, "render");
  let directory: string | undefined;
  try {
    const source = join(root, "source"); mkdirSync(source);
    const summary = "Service Inspect 摘要\n状态：degraded\n";
    writeFileSync(join(source, "runtime-summary.txt"), summary);
    writeFileSync(join(source, "summary.md"), "# Full evidence");
    const artifact = context.artifacts.add({ command: "inspect", path: source });
    expect(await finalizeResult(context, inspectCommand, {
      status: CommandStatus.Ok, output: undefined, artifacts: [artifact],
    }, { format: "summary" })).toBe(0);
    expect(render).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledWith(summary);
    directory = evidenceOutput.mock.calls.map(([line]) => String(line))
      .find(line => line.startsWith("[delivery] Evidence: "))?.trim().slice("[delivery] Evidence: ".length);
    expect(directory).toBeDefined();
    const manifest = JSON.parse(readFileSync(join(directory!, "manifest.json"), "utf8"));
    expect(manifest.delivery.status).toBe("ok");
    expect(readFileSync(join(directory!, manifest.files["runtime-summary.txt"].path), "utf8")).toBe(summary);
    expect(readFileSync(join(directory!, manifest.files.summary.path), "utf8")).toBe("# Full evidence\n");
    expect(existsSync(join(directory!, "report.html"))).toBeFalse();
  } finally {
    render.mockRestore();
    output.mockRestore();
    evidenceOutput.mockRestore();
    await context.disposeClients();
    if (directory) rmSync(directory, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
