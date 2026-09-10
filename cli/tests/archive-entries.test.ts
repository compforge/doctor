import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packArchiveEntries } from "../src/collect/output/archive";
import { readBundleText } from "./bundle-fixture";

test("explicit archive destinations preserve same-named files without source path leakage", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-archive-entries-"));
  try {
    const entries = ["a", "b"].map(id => {
      const dir = join(root, id);
      mkdirSync(dir);
      const source = join(dir, "manifest.json");
      writeFileSync(source, JSON.stringify({ id }));
      return { source, path: `artifacts/${id}/manifest.json` };
    });
    const archive = join(root, "case.tar.gz");
    expect((await packArchiveEntries(entries, archive)).ok).toBe(true);
    for (const id of ["a", "b"]) {
      expect(JSON.parse(readBundleText(archive, `case/artifacts/${id}/manifest.json`))).toEqual({ id });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("archive rejects escaping and overlapping destinations before writing output", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-archive-invalid-"));
  try {
    const source = join(root, "evidence");
    writeFileSync(source, "evidence");
    const archive = join(root, "case.tar.gz");
    for (const paths of [["../escape"], ["/absolute"], ["same", "same"], ["parent", "parent/child"]]) {
      expect((await packArchiveEntries(paths.map(path => ({ source, path })), archive)).ok).toBe(false);
      expect(existsSync(archive)).toBe(false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
