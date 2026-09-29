import { expect, mock, spyOn, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../src/app/command";
import { CommandStatus, defineCommand } from "../src/command";

for (const kind of ["file", "directory", "symlink"] as const) {
  for (const format of ["json", "manifest"]) {
    test(`existing --output ${kind} exits before preparation (${format})`, async () => {
      const directory = mkdtempSync(join(tmpdir(), "doctor-output-preflight-"));
      const output = join(directory, "occupied");
      if (kind === "file") writeFileSync(output, "keep-existing");
      else if (kind === "directory") mkdirSync(output);
      else symlinkSync(join(directory, "missing"), output);
      const config = join(directory, "broken.yaml");
      writeFileSync(config, "profiles: [broken");
      const prepare = mock(async (_context: unknown, input: {}) => input);
      const run = mock(async () => ({ status: CommandStatus.Ok as const, output: undefined, artifacts: [] }));
      const command = defineCommand({ name: "doctor db", prepare, run });
      const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
      const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
      const previousCode = process.exitCode;
      try {
        await runCommand(command, { config, format, output }, {}, { logLevel: "error" });
        expect(process.exitCode).toBe(2);
        expect(prepare).not.toHaveBeenCalled();
        expect(run).not.toHaveBeenCalled();
        expect(stdout).not.toHaveBeenCalled();
        expect(stderr.mock.calls.map(([value]) => String(value)).join("")).toContain(`--output 已存在：${output}`);
        if (kind === "file") expect(readFileSync(output, "utf8")).toBe("keep-existing");
        else if (kind === "directory") expect(lstatSync(output).isDirectory()).toBe(true);
        else expect(lstatSync(output).isSymbolicLink()).toBe(true);
      } finally {
        stdout.mockRestore();
        stderr.mockRestore();
        process.exitCode = previousCode;
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
}
