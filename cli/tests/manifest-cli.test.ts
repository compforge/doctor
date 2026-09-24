import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

for (const fixture of [true, false]) {
  test(`manifest delivery follows distribution logging policy in a subprocess (${fixture ? "distribution composite" : "Core capability failure"})`, () => {
    const directory = mkdtempSync(join(tmpdir(), "doctor-manifest-process-"));
    try {
      const entry = fixture ? "fixtures/manifest-cli.ts" : "../src/app/entry.ts";
      const result = Bun.spawnSync({
        cmd: [process.execPath, "run", resolve(import.meta.dir, entry), ...(fixture ? ["collect"] : ["log", "--format", "manifest"]),
          "--config", join(directory, "missing.yaml"), "--output", join(directory, "evidence")],
        cwd: directory, env: { ...process.env, NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe",
      });
      expect(result.exitCode, result.stderr.toString()).toBe(fixture ? 0 : 1);
      expect(readdirSync(directory).filter(name => name.startsWith("doctor-error-"))).toEqual([]);
      expect(result.stderr.toString()).not.toContain("技术详情:");
      const manifest = fixture ? JSON.parse(result.stdout.toString())
        : JSON.parse(readFileSync(join(directory, "evidence", "manifest.json"), "utf8"));
      if (!fixture) {
        expect(result.stdout.toString()).toContain("profile:");
        expect(result.stdout.toString()).toEndWith(`${JSON.stringify(manifest, null, 2)}\n`);
      }
      expect(manifest.execution.status).toBe(fixture ? "partial" : "failed");
      expect(manifest.schemaVersion).toBe(2);
      expect(manifest.delivery.location.directory).toBe(join(directory, "evidence"));
      expect(JSON.parse(readFileSync(join(manifest.delivery.location.directory, "manifest.json"), "utf8"))).toEqual(manifest);
      if (fixture) {
        expect(result.stderr.toString()).not.toContain("collecting evidence");
        expect(manifest.children).toHaveLength(1);
        const childPath = join(manifest.delivery.location.directory, manifest.children[0].manifest);
        const child = JSON.parse(readFileSync(childPath, "utf8"));
        expect(readFileSync(join(childPath, "..", child.files["raw/log.txt"].path), "utf8")).toBe("captured log");
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 15_000);
}
