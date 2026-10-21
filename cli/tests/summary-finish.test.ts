import { expect, spyOn, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { CommandContext, CommandStatus, defineCommand } from "../src/command";
import type { Manifest } from "../src/command/manifest";
import { summaryText } from "../src/command/summary";
import { captureSerializedDirectory, finalizeResult } from "./report-fixture";

for (const format of ["summary", "manifest"] as const) {
  test(`${format} finish selects presentation while preserving the complete result tree`, async () => {
    const context = new CommandContext({});
    const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    const captured = captureSerializedDirectory();
    const childResult = { status: CommandStatus.Partial as const, reason: "one source unavailable", artifacts: [],
      output: { value: "[literal value](raw/facts.json)", raw: "RAW_BODY".repeat(1000) },
      summary: { title: "Child result", text: "1 value collected; 1 source unavailable",
        fields: [{ label: "Value", path: ["value"] }] } };
    const child = defineCommand({ name: "doctor data", prepare: async (_ctx, input: {}) => input,
      run: async () => childResult });
    const result = { status: CommandStatus.Partial as const, artifacts: [], output: [childResult] };
    const parent = defineCommand({ name: "doctor collect", prepare: async (_ctx, input: {}) => input,
      run: async () => result,
      serialize: async writer => ({ files: {}, children: [await writer.serialize(child, childResult)] }),
    });
    try {
      expect(await finalizeResult(context, parent, result, { format })).toBe(0);
      const out = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
      const err = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
      const directory = captured.directory!;
      const manifest: Manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
      const reference = manifest.children![0]!;
      const childPath = join(directory, reference.manifest);
      const childManifest: Manifest = JSON.parse(readFileSync(childPath, "utf8"));
      const saved = JSON.parse(readFileSync(join(dirname(childPath), childManifest.files.output!.path), "utf8"));
      expect(saved).toEqual(childResult.output);
      expect(childManifest.execution.reason).toBe("one source unavailable");
      expect(err).toBe("");
      if (format === "summary") {
        expect(out).toContain("Child result");
        expect(out).toContain("one source unavailable");
        expect(out).toContain("1 value collected");
        expect(out).toContain(summaryText("[literal value](raw/facts.json)"));
        expect(out).not.toContain("## 证据导航");
        expect(out).not.toContain("manifest.json");
        expect(out).not.toContain("[delivery]");
        expect(out).not.toContain("RAW_BODY");
      } else {
        expect(JSON.parse(out).children).toEqual(manifest.children);
        expect(JSON.parse(out).delivery.location.directory).toBe(directory);
        const summary = readFileSync(join(directory, manifest.files.summary!.path), "utf8");
        expect(summary).toContain("## 证据导航");
        expect(summary).toContain(reference.manifest);
      }
    } finally {
      stdout.mockRestore(); stderr.mockRestore();
      const directory = captured.directory;
      captured.restore();
      await context.disposeClients();
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });
}
