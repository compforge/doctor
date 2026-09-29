import { describe, expect, test } from "bun:test";
import { defaultCommandReportName } from "../src/command/report-name";

const NOW = new Date(2026, 8, 22, 15, 4, 5); // 2026-09-22 15:04:05

describe("defaultCommandReportName", () => {
  test("单个 id：带 id 与时间戳", () => {
    expect(defaultCommandReportName("trace", ["01a0c7f4fdb67fa4a02ade4a63a8f001"], NOW))
      .toBe("doctor-trace-01a0c7f4fdb6-20260922-150405");
  });

  test("多个 id：只用第一个", () => {
    expect(defaultCommandReportName("trace", ["bbbbbbbbbbbbbbbb", "aaaaaaaaaaaaaaaa"], NOW))
      .toBe("doctor-trace-bbbbbbbbbbbb-20260922-150405");
  });

  test("无 id：退回命令名 + 时间戳", () => {
    expect(defaultCommandReportName("trace", [], NOW)).toBe("doctor-trace-20260922-150405");
  });

  test("id 含非字母数字字符时先清洗再截断", () => {
    expect(defaultCommandReportName("trace", ["01a0-c7f4/fdb67fa4a02ade4a63a8f001"], NOW))
      .toBe("doctor-trace-01a0c7f4fdb6-20260922-150405");
  });

  test("doctor 前缀与空格规范化", () => {
    expect(defaultCommandReportName("doctor trace", ["abcdef0123456789"], NOW))
      .toBe("doctor-trace-abcdef012345-20260922-150405");
    expect(defaultCommandReportName("doctor collect cpu", [], NOW))
      .toBe("doctor-collect-cpu-20260922-150405");
  });
});

import { CommandContext, CommandStatus, defineCommand, type CommandInput } from "../src/command";
import { finalizeCommand } from "../src/app/finalize";
import { commandExitCode } from "../src/app/command";
import { traceCommand } from "../src/collect/trace/command";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("root delivery report naming", () => {
  for (const mode of ["ok", "cancel", "throw", "abort", "validation"] as const) {
    test(`finalize names ${mode} results from the original invocation`, async () => {
      const root = mkdtempSync(join(tmpdir(), "doctor-name-test-"));
      const context = new CommandContext({});
      let calls = 0;
      const spec = defineCommand<CommandInput & { bizIds: string[] }, number>({
        name: "doctor trace",
        validate: () => { if (mode === "validation") throw new Error("invalid"); },
        prepare: async (ctx, input) => {
          if (mode === "throw") throw new Error("prepare failed");
          if (mode === "abort") ctx.cancel();
          return mode === "cancel" ? undefined : input;
        },
        run: async () => ({ status: CommandStatus.Ok, output: 1, artifacts: [] }),
        serialize: async (writer, result) => ({ files: { diagnosis: writer.writeJson("diagnosis.json", result.output ?? null) } }),
        reportName: (input, result, now) => {
          calls++;
          expect(result.status).toBe(mode === "ok" ? CommandStatus.Ok
            : mode === "throw" || mode === "validation" ? CommandStatus.Failed : CommandStatus.Cancelled);
          return defaultCommandReportName("trace", input.bizIds, now);
        },
      });
      const commandInput = { bizIds: ["01a0c7f4fdb67fa4a02ade4a63a8f001"] };
      try {
        const result = await spec.run(context, commandInput);
        expect(calls).toBe(0); // Child execution must not choose the root delivery name.
        expect("reportName" in result).toBe(false);
        const code = await finalizeCommand({ context, spec, commandInput, result,
          delivery: { format: "manifest", output: join(root, "result") }, code: commandExitCode(result) });
        expect(code).toBe(commandExitCode(result));
        expect(calls).toBe(1);
        expect(existsSync(join(root, "result", "manifest.json"))).toBe(true);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }

  test("trace uses online business IDs and offline evidence IDs through the same hook", () => {
    const result = { status: CommandStatus.Ok as const, output: { items: [{ bizId: "offline",
      traceIds: ["abcdef0123456789", "other"], status: CommandStatus.Ok, artifacts: [] }] }, artifacts: [] };
    expect(traceCommand.reportName!({ bizIds: ["online123456789"] }, result, NOW))
      .toBe("doctor-trace-online123456-20260922-150405");
    expect(traceCommand.reportName!({ bizIds: [], from: "evidence" }, result, NOW))
      .toBe("doctor-trace-abcdef012345-20260922-150405");
    expect(traceCommand.reportName!({ bizIds: [], from: "missing" },
      { status: CommandStatus.Failed, artifacts: [] }, NOW)).toBe("doctor-trace-20260922-150405");
  });
});
