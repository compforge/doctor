import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandContext } from "../src/command";
import { deliverCommandArtifacts } from "../src/app/delivery";

for (const format of ["json", "md"] as const) {
  test(`${format} retains distinct artifacts with the same command and deduplicates shared references`, async () => {
    const root = mkdtempSync(join(tmpdir(), "doctor-delivery-format-"));
    const context = new CommandContext({});
    const ids: string[] = [];
    try {
      for (const bizId of ["request-a", "request-b"]) {
        const path = join(root, bizId); mkdirSync(path);
        writeFileSync(join(path, "diagnosis.json"), JSON.stringify({ bizId }));
        writeFileSync(join(path, "summary.md"), `Evidence for ${bizId}`);
        const artifact = context.artifacts.add({ command: "log", path });
        ids.push(artifact.id);
        context.artifacts.add(artifact);
      }
      const output = join(root, `report.${format}`);
      expect(await deliverCommandArtifacts(context, { format, output }, 0, "doctor overview")).toBeTrue();
      const rendered = readFileSync(output, "utf8");
      for (const value of [...ids, "request-a", "request-b"]) expect(rendered).toContain(value);
      if (format === "json") expect(JSON.parse(rendered).artifacts).toEqual([
        { id: ids[0], command: "log", diagnosis: { bizId: "request-a" } },
        { id: ids[1], command: "log", diagnosis: { bizId: "request-b" } },
      ]);
      else expect(rendered.match(/^# log/gm)).toHaveLength(2);
    } finally { await context.disposeClients(); rmSync(root, { recursive: true, force: true }); }
  });
}

test("single JSON artifact still exposes its domain diagnosis directly", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-delivery-single-"));
  const context = new CommandContext({});
  try {
    const source = join(root, "source"); mkdirSync(source);
    writeFileSync(join(source, "diagnosis.json"), '{"facts":[1]}');
    context.artifacts.add({ command: "log", path: source });
    const output = join(root, "report.json");
    expect(await deliverCommandArtifacts(context, { format: "json", output }, 0)).toBeTrue();
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual({ facts: [1] });
  } finally { await context.disposeClients(); rmSync(root, { recursive: true, force: true }); }
});
