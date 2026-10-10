import { expect, spyOn, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createDoctorProgram } from "../src/app/main";
import { CommandContext, CommandStatus } from "../src/command";
import { logCommand } from "../src/collect/log/command";
import type { LogOutput } from "../src/collect/log";
import { logSummary } from "../src/collect/log/summary";
import { finalizeResult } from "./report-fixture";

test("log exposes summary and allows distributions to select it as default", () => {
  const program = createDoctorProgram({ commandDefaults: { log: { format: "summary" } } });
  const log = program.commands.find(command => command.name() === "log")!;
  const format = log.options.find(option => option.long === "--format")!;
  expect(format.argChoices).toContain("summary");
  expect(log.helpInformation()).toContain("summary");
});

for (const format of ["summary", "manifest"] as const) {
  test(`log ${format} retains every query while terminal summary is bounded`, async () => {
    const context = new CommandContext({});
    const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    const render = spyOn(logCommand, "render");
    let directory: string | undefined;
    try {
      const output: LogOutput = { namespace: "test", services: ["api"], items: Array.from({ length: 30 }, (_, i) => ({
        bizId: `request-${i}`, status: i ? CommandStatus.Ok : CommandStatus.Failed,
        ...(i ? {} : { reason: "trace resolution failed" }), artifacts: [],
      })) };
      const code = await finalizeResult(context, logCommand, {
        status: CommandStatus.Partial, output, summary: logSummary(output), artifacts: [],
      }, { format });
      expect(render).not.toHaveBeenCalled();
      const terminal = stdout.mock.calls.map(([line]) => String(line)).join("");
      if (format === "summary") {
        directory = stderr.mock.calls.map(([line]) => String(line))
          .find(line => line.startsWith("[delivery] Evidence: "))?.trim().slice("[delivery] Evidence: ".length);
        expect(terminal).toContain("trace resolution failed");
        expect(terminal).toContain("见原始数据");
        expect(terminal).not.toContain("request-29");
        expect(terminal.length).toBeLessThan(3000);
      } else {
        const manifest = JSON.parse(terminal);
        directory = manifest.delivery.location.directory;
        expect(manifest.execution.status).toBe("partial");
        expect(manifest.delivery.exitCode).toBe(code);
      }
      expect(directory).toBeDefined();
      expect(JSON.parse(readFileSync(join(directory!, "output.json"), "utf8"))).toEqual(output);
      const manifest = JSON.parse(readFileSync(join(directory!, "manifest.json"), "utf8"));
      expect(manifest.serialization.status).toBe("ok");
      expect(manifest.delivery.status).toBe("ok");
    } finally {
      render.mockRestore(); stdout.mockRestore(); stderr.mockRestore();
      await context.disposeClients();
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });
}
