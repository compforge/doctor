import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

for (const fixture of [true, false]) {
  test(`manifest stdout is a single JSON document in a subprocess (${fixture ? "distribution composite" : "Core capability failure"})`, () => {
    const directory = mkdtempSync(join(tmpdir(), "doctor-manifest-process-"));
    try {
      const entry = fixture ? "fixtures/manifest-cli.ts" : "../src/app/entry.ts";
      const result = Bun.spawnSync({
        cmd: [process.execPath, "run", resolve(import.meta.dir, entry), ...(fixture ? ["collect"] : ["log", "--format", "manifest"]),
          "--config", join(directory, "missing.yaml"), "--output", join(directory, "evidence")],
        cwd: directory, env: { ...process.env, NO_COLOR: "1", DOCTOR_ERROR_LOG: join(directory, "error.log") }, stdout: "pipe", stderr: "pipe",
      });
      expect(result.exitCode, result.stderr.toString()).toBe(fixture ? 0 : 1);
      const manifest = JSON.parse(result.stdout.toString());
      expect(manifest.status).toBe(fixture ? "partial" : "failed");
      expect(manifest.schemaVersion).toBe(1);
      expect(manifest.bundle_root).toBe(join(directory, "evidence"));
      expect(JSON.parse(readFileSync(join(manifest.bundle_root, "manifest.json"), "utf8"))).toEqual(manifest);
      if (fixture) {
        expect(result.stderr.toString()).toContain("collecting evidence");
        expect(manifest.children).toHaveLength(1);
        const childPath = join(manifest.bundle_root, manifest.children[0].manifest);
        const child = JSON.parse(readFileSync(childPath, "utf8"));
        expect(readFileSync(join(childPath, "..", child.files["raw/log.txt"].path), "utf8")).toBe("captured log");
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 15_000);
}
