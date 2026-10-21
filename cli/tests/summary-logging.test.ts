import { expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { runCommand } from "../src/app/command";
import { CommandStatus, defineCommand } from "../src/command";
import { onCommandDispose } from "../src/command/execution-scope";
import { useLogger } from "../src/terminal/log";

for (const [format, logLevel, progress, warnings] of [
  ["summary", undefined, false, true],
  ["summary", "verbose", false, true],
  ["summary", "error", false, false],
  ["manifest", undefined, true, true],
] as const) {
  test(`summary logging policy spans preparation, execution and cleanup: ${format}/${logLevel ?? "default"}`, async () => {
    const previousExitCode = process.exitCode;
    const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    const command = defineCommand({
      name: "fixture",
      prepare: async (_context, input: {}) => {
        useLogger("k8s").success("FIXTURE_PREPARATION_PROGRESS");
        return input;
      },
      run: async () => {
        onCommandDispose(() => { useLogger().info("FIXTURE_CLEANUP_PROGRESS"); });
        useLogger().info("FIXTURE_EXECUTION_PROGRESS");
        useLogger().warn("FIXTURE_WARNING");
        useLogger().error("FIXTURE_ERROR");
        return { status: CommandStatus.Ok, artifacts: [], output: { value: "actual-result" },
          summary: { title: "Actual summary", fields: [{ label: "Value", path: ["value"] }] } };
      },
    });
    let directory: string | undefined;
    try {
      await runCommand(command, { config: "", format }, {}, { printProfile: false, logLevel });
      const out = stdout.mock.calls.map(([value]) => String(value)).join("");
      const err = stderr.mock.calls.map(([value]) => String(value)).join("");
      const terminal = out + err;
      for (const stage of ["PREPARATION", "EXECUTION", "CLEANUP"]) expect(terminal.includes(`FIXTURE_${stage}_PROGRESS`)).toBe(progress);
      expect(terminal.includes("FIXTURE_WARNING")).toBe(warnings);
      expect(err).toContain("FIXTURE_ERROR");
      if (format === "summary") {
        expect(out).toContain("Actual summary");
        expect(out).toContain("actual-result");
        directory = err.split("\n").find(line => line.startsWith("[delivery] Evidence: "))?.slice("[delivery] Evidence: ".length);
      } else {
        const record = JSON.parse(out.slice(out.indexOf("{")));
        directory = record.delivery.location.directory;
      }
      expect(directory).toBeDefined();
    } finally {
      stdout.mockRestore(); stderr.mockRestore();
      process.exitCode = previousExitCode;
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });
}

for (const format of ["summary", "text"]) {
  test(`standalone and nested CLI actions share output logging policy: ${format}`, async () => {
    const { CliCommand } = await import("../src/app/cli-command");
    const { runStandaloneCommand } = await import("../src/app/command");
    const { writeOutput } = await import("../src/terminal/output");
    const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    const previousExitCode = process.exitCode;
    try {
      const program = new CliCommand();
      const directory = program.command("directory").option("-f, --format <format>", "output format", format);
      for (const command of [directory, directory.command("list")]) {
        command.action(async () => runStandaloneCommand("fixture", async () => {
          useLogger().info("STANDALONE_PROGRESS");
          useLogger().success("STANDALONE_SUCCESS");
          useLogger().warn("STANDALONE_WARNING");
          useLogger().error("STANDALONE_ERROR");
          writeOutput("STANDALONE_RESULT\n");
        }));
      }
      for (const args of [["directory"], ["directory", "list"]]) {
        stdout.mockClear(); stderr.mockClear();
        await program.parseAsync(args, { from: "user" });
        const out = stdout.mock.calls.map(([value]) => String(value)).join("");
        const err = stderr.mock.calls.map(([value]) => String(value)).join("");
        expect((out + err).includes("STANDALONE_PROGRESS")).toBe(format !== "summary");
        expect((out + err).includes("STANDALONE_SUCCESS")).toBe(format !== "summary");
        expect(out + err).toContain("STANDALONE_WARNING");
        expect(err).toContain("STANDALONE_ERROR");
        expect(out).toContain("STANDALONE_RESULT");
      }
    } finally {
      stdout.mockRestore(); stderr.mockRestore(); process.exitCode = previousExitCode;
    }
  });
}
