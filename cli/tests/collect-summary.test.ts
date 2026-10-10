import { createServiceCatalog } from "@compforge/doctor-plugin";
import { expect, spyOn, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import * as execution from "../src/app/command";
import { createDoctorProgram } from "../src/app/main";
import { createCollectCommand } from "../src/collect/composite";
import { parseMetricOutputFormat } from "../src/collect/metric/config";
import { parseTraceOutputFormat } from "../src/collect/trace";
import { CommandContext, CommandStatus } from "../src/command";
import { commandOptions } from "../src/command/options";
import { finalizeResult } from "./report-fixture";

test("collect accepts explicit summary without changing the distribution default", async () => {
  const run = spyOn(execution, "runCommand").mockResolvedValue(undefined);
  try {
    for (const explicit of [false, true]) {
      const program = createDoctorProgram({ commandDefaults: { collect: { format: "manifest" } } });
      await program.parseAsync(["collect", "--include", "inspect", ...(explicit ? ["-f", "summary"] : [])], { from: "user" });
      expect(run.mock.calls.at(-1)![1].format).toBe(explicit ? "summary" : "manifest");
    }
    expect(createDoctorProgram().commands.find(command => command.name() === "collect")!.opts().format).toBeUndefined();
  } finally { run.mockRestore(); }
});

for (const format of ["summary", "manifest"]) {
  test(`root ${format} prepares complete evidence with legacy Trace and Metric collectors`, async () => {
    const context = new CommandContext({}, undefined, { format });
    try {
      const options = commandOptions(context);
      expect(parseTraceOutputFormat(options.format)).toBe("bundle");
      expect(parseMetricOutputFormat(options.format)).toBe("bundle");
      expect(context.options.format).toBe(format);
    } finally { await context.disposeClients(); }
  });
}

test("collect summary rejects output before preparing Plugin or running delegates", async () => {
  const loadPlugin = spyOn({ load: async () => undefined }, "load");
  const context = new CommandContext({}, undefined, { format: "summary", output: "report", loadPlugin });
  try {
    const result = await createCollectCommand().run(context, { bizIds: [], kinds: ["inspect"] });
    expect(result.status).toBe(CommandStatus.Failed);
    expect("reason" in result && result.reason).toContain("不支持 --output");
    expect(loadPlugin).not.toHaveBeenCalled();
  } finally { await context.disposeClients(); loadPlugin.mockRestore(); }
});

for (const format of ["summary", "manifest"] as const) {
  test(`collect ${format} retains child evidence and reports partial failure without rendering`, async () => {
    const context = new CommandContext({}, undefined, { format, plugin: {
      id: "fixture", version: "1.0.0", services: createServiceCatalog([]),
    } });
    const output = { namespace: "test", services: ["api"], items: Array.from({ length: 30 }, (_, i) => ({
      bizId: `request-${i}`, status: CommandStatus.Ok, artifacts: [],
    })) };
    const command = createCollectCommand(async kind => kind === "log"
      ? { status: CommandStatus.Ok, output, artifacts: [],
        summary: { title: "Logs", text: "30 requests collected", fields: [] } }
      : { status: CommandStatus.Failed, artifacts: [], reason: "metrics unavailable" });
    const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    const render = spyOn(command, "render");
    let directory: string | undefined;
    try {
      const input = { bizIds: ["request-0"], kinds: ["log", "metric"] as const };
      const result = await command.run(context, { ...input, kinds: [...input.kinds] });
      expect(result.status).toBe(CommandStatus.Partial);
      const code = await finalizeResult(context, command, result, { format });
      expect(render).not.toHaveBeenCalled();
      const terminal = stdout.mock.calls.map(([line]) => String(line)).join("");
      if (format === "summary") {
        directory = stderr.mock.calls.map(([line]) => String(line))
          .find(line => line.startsWith("[delivery] Evidence: "))?.trim().slice("[delivery] Evidence: ".length);
        expect(terminal).toContain("log: ok");
        expect(terminal).toContain("metric: failed");
        expect(terminal).toContain("metrics unavailable");
        expect(terminal).toContain("30 requests collected");
        expect(terminal).toContain("manifest.json");
        expect(terminal).not.toContain("request-29");
        expect(terminal.length).toBeLessThan(3000);
      } else {
        directory = JSON.parse(terminal).delivery.location.directory;
      }
      expect(directory).toBeDefined();
      const manifest = JSON.parse(readFileSync(join(directory!, "manifest.json"), "utf8"));
      expect(manifest.execution.status).toBe("partial");
      expect(manifest.delivery.exitCode).toBe(code);
      expect(manifest.serialization.status).toBe("ok");
      expect(manifest.children).toHaveLength(2);
      const logPath = join(directory!, manifest.children[0].manifest);
      const log = JSON.parse(readFileSync(logPath, "utf8"));
      expect(JSON.parse(readFileSync(join(dirname(logPath), log.files.output.path), "utf8"))).toEqual(output);
      const metric = JSON.parse(readFileSync(join(directory!, manifest.children[1].manifest), "utf8"));
      expect(metric.execution).toMatchObject({ status: "failed", reason: "metrics unavailable" });
    } finally {
      render.mockRestore(); stdout.mockRestore(); stderr.mockRestore();
      await context.disposeClients();
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });
}
