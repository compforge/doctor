import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildNodeDoctor } from "../scripts/build-node-doctor";

// +case=A Node distribution embeds VERSION and runs after its source metadata is removed.
test("built version is independent of source files and runtime working directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-version-bundle-"));
  try {
    const sourceRoot = join(root, "source");
    const source = join(sourceRoot, "cli/src/app/version.ts");
    mkdirSync(dirname(source), { recursive: true });
    copyFileSync(resolve(import.meta.dir, "../src/app/version.ts"), source);
    writeFileSync(join(sourceRoot, "VERSION"), "3.4.5\n");
    const entry = join(sourceRoot, "entry.ts");
    writeFileSync(entry, 'import { formatDoctorVersion } from "./cli/src/app/version"; console.log(formatDoctorVersion(undefined));\n');
    const outfile = join(root, "dist/doctor.mjs");
    await buildNodeDoctor({ entry, outfile });
    rmSync(sourceRoot, { recursive: true });
    expect(existsSync(sourceRoot)).toBe(false);
    const result = Bun.spawnSync([resolve(import.meta.dir, "../node_modules/node/bin/node"), outfile], {
      cwd: dirname(outfile), stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toBe("doctor 3.4.5\nplugin none\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
