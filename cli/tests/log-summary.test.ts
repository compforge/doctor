import { createServiceCatalog } from "@compforge/doctor-plugin";
import { createCollectCommand } from "../src/collect/composite";
import { expect, spyOn, test } from "bun:test";
import { readFileSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { SerializeContext } from "../src/command/serialization/context";
import { collectedFact } from "../src/collect/protocol";
import type { DataOutput } from "../src/collect/data/model";
import { join } from "node:path";
import { createDoctorProgram } from "../src/app/main";
import { CommandContext, CommandStatus } from "../src/command";
import { logCommand } from "../src/collect/log/command";
import type { LogOutput } from "../src/collect/log";
import { logSummary } from "../src/collect/log/summary";
import { captureSerializedDirectory, finalizeResult } from "./report-fixture";

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
    const captured = captureSerializedDirectory();
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
        directory = captured.directory;
        expect(terminal).toContain("trace resolution failed");
        expect(terminal).toContain("未在摘要中展示");
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
      render.mockRestore(); stdout.mockRestore(); stderr.mockRestore(); captured.restore();
      await context.disposeClients();
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });
}


test("Log root surfaces producer Data text and navigates directly to its Fact evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-log-text-"));
  const context = new CommandContext({});
  try {
    const facts = { services: {}, capabilityResults: [{
      id: "q1", stage: "provide" as const, service: "sample", identity: { kind: "biz_id", value: "s1" },
      ...collectedFact("data.inspect-result", "test", { result: {
        resolution: { inputId: "s1", resolvedAs: "run_id", identifiers: { run_id: "s1" } },
        facts: [{ factType: "record" as const, kind: "run", schemaVersion: 1, recordKey: "s1",
          record: { ready: true, observation: null },
          summary: { title: "Run", text: "Carrier Ready; Sandbox observation absent", fields: [] } }],
      } }),
    }] };
    writeFileSync(join(root, "facts.json"), JSON.stringify(facts));
    writeFileSync(join(root, "collection.json"), JSON.stringify({ files: { facts: "facts.json" } }));
    const artifact = context.artifacts.add({ command: "data", path: root });
    const data: DataOutput = { items: [{ bizId: "s1", status: CommandStatus.Ok, artifacts: [artifact],
      diagnosis: { evidence: { facts, observations: [] }, findings: [], coverage: [] } }] };
    const output: LogOutput = { namespace: "test", services: ["sample"], items: [],
      identityResolution: { status: CommandStatus.Ok, output: data, artifacts: [artifact] } };
    const directory = join(root, "delivered");
    await SerializeContext.create(directory, logCommand, {
      status: CommandStatus.Ok, output, summary: logSummary(output), artifacts: [],
    });
    const text = readFileSync(join(directory, "summary.md"), "utf8");
    expect(text).toContain("Carrier Ready; Sandbox observation absent");
    expect(text).toContain("capabilityResults.0.result.facts.0");
    const path = /\[facts\]\(<([^>]+)>\)/.exec(text)![1]!;
    const stored = JSON.parse(readFileSync(join(directory, path), "utf8"));
    expect(stored.capabilityResults[0].result.facts[0].record).toEqual({ ready: true, observation: null });
    const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
    expect(manifest.serialization.status).toBe("ok");
  } finally { await context.disposeClients(); rmSync(root, { recursive: true, force: true }); }
});

/** @case id=log-partial-evidence,desc=`关联失败时保留已采日志和判断边界`,expect=`4 Pod and 92 events remain visible alongside the correlation failure` */
for (const captureGap of [undefined, "Pod api-pod 只取得部分 current 日志"]) {
  for (const mode of ["log", "collect"] as const) {
    test(`${mode} partial summary retains counts and separates gaps (capture gap: ${!!captureGap})`, async () => {
      const context = new CommandContext({}, undefined, { format: "summary", plugin: {
        id: "fixture", version: "1.0.0", services: createServiceCatalog([]),
      } });
      const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
      const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
      const captured = captureSerializedDirectory();
      let directory: string | undefined;
      try {
        const gap = "worker sandbox_id:s1 查询失败：from must equal the Query identity";
        const output: LogOutput = { namespace: "test", services: ["api", "worker"], items: [{
          bizId: "request-a", status: CommandStatus.Partial, artifacts: [],
          stats: { podCount: 4, scannedPodCount: 4, matchedPodCount: 4, matchedEventCount: 92,
            previousContainerCount: 0, partialCount: captureGap ? 1 : 0, unavailableCount: 0, bytesRead: 4096, wallMs: 10 },
          resolutionGaps: [gap], missingEvidence: [gap, ...(captureGap ? [captureGap] : [])],
        }] };
        const result = { status: CommandStatus.Partial, output, summary: logSummary(output), artifacts: [] };
        if (mode === "log") {
          await finalizeResult(context, logCommand, result, { format: "summary" });
        } else {
          const command = createCollectCommand(async () => result);
          const input = { bizIds: ["request-a"], kinds: ["log" as const] };
          await finalizeResult(context, command, await command.run(context, input), { format: "summary" }, input);
        }
        const terminal = stdout.mock.calls.map(([line]) => String(line)).join("");
        expect(terminal).toContain(mode === "log" ? "采集状态：partial" : "log: partial");
        expect(terminal).toContain("已获得匹配事件（非错误数）：92");
        expect(terminal).toContain("扫描 Pod：4");
        expect(terminal).toContain("worker sandbox\\_id:s1 查询失败：from must equal the Query identity");
        expect(terminal.split("from must equal the Query identity")).toHaveLength(2);
        expect(terminal).toContain("已获得的日志仍可用于分析");
        expect(terminal).toContain("不能据此排除相关对象的问题");
        if (captureGap) {
          expect(terminal).toContain(`采集缺口：${captureGap}`);
          expect(terminal).toContain("不能据此判断完整时间线");
        } else {
          expect(terminal).not.toContain("采集缺口影响");
        }
        directory = captured.directory;
        expect(directory).toBeDefined();
        const manifest = JSON.parse(readFileSync(join(directory!, "manifest.json"), "utf8"));
        expect(manifest.execution.status).toBe("partial");
        expect(manifest.delivery.status).toBe("ok");
        const outputPath = mode === "log" ? join(directory!, "output.json")
          : join(directory!, manifest.children[0].manifest, "..", "output.json");
        expect(JSON.parse(readFileSync(outputPath, "utf8"))).toEqual(output);
      } finally {
        stdout.mockRestore(); stderr.mockRestore(); captured.restore();
        await context.disposeClients();
        if (directory) rmSync(directory, { recursive: true, force: true });
      }
    });
  }
}
