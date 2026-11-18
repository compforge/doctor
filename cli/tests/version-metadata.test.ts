import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildNodeDoctor } from "../scripts/build-node-doctor";

// +case=Version bump updates only root metadata, including explicit versions; invalid input leaves it unchanged.
test("bump-version owns root VERSION without rewriting TypeScript", () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-version-bump-"));
  try {
    const script = join(root, "cli/scripts/bump-version.ts");
    const source = join(root, "cli/src/app/version.ts");
    mkdirSync(dirname(script), { recursive: true });
    mkdirSync(dirname(source), { recursive: true });
    copyFileSync(resolve(import.meta.dir, "../scripts/bump-version.ts"), script);
    copyFileSync(resolve(import.meta.dir, "../src/app/version.ts"), source);
    const before = readFileSync(source, "utf8");
    const version = join(root, "VERSION");
    writeFileSync(version, "1.2.3\n");
    for (const [args, expected] of [[[], "1.2.4\n"], [["2.0.0"], "2.0.0\n"]] as const) {
      const result = Bun.spawnSync([process.execPath, script, ...args], { cwd: tmpdir() });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(readFileSync(version, "utf8")).toBe(expected);
      expect(readFileSync(source, "utf8")).toBe(before);
    }
    const invalid = Bun.spawnSync([process.execPath, script, "invalid"], { cwd: tmpdir() });
    expect(invalid.exitCode).not.toBe(0);
    expect(readFileSync(version, "utf8")).toBe("2.0.0\n");
    writeFileSync(version, "malformed\n");
    const malformed = Bun.spawnSync([process.execPath, script], { cwd: tmpdir() });
    expect(malformed.exitCode).not.toBe(0);
    expect(readFileSync(version, "utf8")).toBe("malformed\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
