import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("compiled Doctor command re-execs its binary without a Bun virtual entry", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-compiled-command-test-"));
  const executable = join(root, "doctor");
  try {
    const build = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "../tests/fixtures/compiled-agent-command.ts")],
      compile: { target: `bun-${process.platform}-${process.arch}` as Bun.Build.CompileTarget, outfile: executable },
    });
    expect(build.success, build.logs.map(String).join("\n")).toBe(true);
    const result = Bun.spawnSync({ cmd: [executable], stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual([
      "--distribution", expect.any(String), "--config", "/tmp/doctor-config.yaml", "version",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
