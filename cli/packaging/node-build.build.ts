import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("runtime-free build runs on Node without node_modules and keeps command selection", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-node-build-"));
  try {
    const outfile = join(root, "sample.mjs");
    // Run the release entrypoint in its own process: previous in-process Bun builds can retain
    // stale file state after other tests delete their temporary compilation directories.
    const build = Bun.spawnSync([
      process.execPath, resolve(import.meta.dir, "../scripts/build-node-doctor.ts"),
      "--entry", resolve(import.meta.dir, "../src/app/entry.ts"),
      "--outfile", outfile, "--commands", "inspect,plugin",
    ], { stdout: "pipe", stderr: "pipe" });
    expect(build.exitCode, build.stderr.toString()).toBe(0);
    expect(readdirSync(root).sort()).toEqual(["sample", "sample.mjs"]);
    expect(readFileSync(join(root, "sample"), "utf8")).toContain('exec node "$(dirname "$0")/sample.mjs" "$@"');
    const node = resolve(import.meta.dir, "../node_modules/node/bin/node");
    const result = Bun.spawnSync({
      cmd: [node, outfile, "--help"], cwd: root,
      env: { ...process.env, DOCTOR_HOME: root, DOCTOR_COMMANDS: "all" },
      stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toContain("Usage: doctor");
    expect(result.stdout.toString()).toContain("--kubeconfig <path>");
    expect(result.stdout.toString()).toMatch(/^  inspect /m);
    expect(result.stdout.toString()).not.toMatch(/^  chat /m);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
