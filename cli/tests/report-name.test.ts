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

describe("CommandSpec.reportName wiring", () => {
  const noop = async () => ({ status: CommandStatus.Ok, output: 1, artifacts: [] });

  test("result 未设 reportName 时用 spec hook 从 input 推导", async () => {
    const spec = defineCommand<CommandInput & { bizIds: string[] }, number>({
      name: "doctor trace",
      prepare: async (_context, input) => input,
      run: noop,
      reportName: (input, now) => defaultCommandReportName("trace", input.bizIds, now),
    });
    const result = await spec.run(new CommandContext({}), { bizIds: ["01a0c7f4fdb67fa4a02ade4a63a8f001"] });
    expect(result.reportName).toMatch(/^doctor-trace-01a0c7f4fdb6-\d{8}-\d{6}$/);
  });

  test("result.reportName 优先于 spec hook", async () => {
    const spec = defineCommand<CommandInput & { bizIds: string[] }, number>({
      name: "doctor trace",
      prepare: async (_context, input) => input,
      run: async () => ({ status: CommandStatus.Ok, output: 1, artifacts: [], reportName: "from-result" }),
      reportName: (input, now) => defaultCommandReportName("trace", input.bizIds, now),
    });
    const result = await spec.run(new CommandContext({}), { bizIds: ["aaaaaaaaaaaaaaaa"] });
    expect(result.reportName).toBe("from-result");
  });

  test("prepare 取消（prepared=undefined）也用 spec hook 命名，不再落裸 doctor-trace", async () => {
    const spec = defineCommand<CommandInput & { bizIds: string[] }, number>({
      name: "doctor trace",
      prepare: async () => undefined,
      run: noop,
      reportName: (input, now) => defaultCommandReportName("trace", input.bizIds, now),
    });
    const result = await spec.run(new CommandContext({}), { bizIds: ["550e50d64040fffdffe1a0b623f0ce8d"] });
    expect(result.status).toBe(CommandStatus.Cancelled);
    expect(result.reportName).toMatch(/^doctor-trace-550e50d64040-\d{8}-\d{6}$/);
  });
});
