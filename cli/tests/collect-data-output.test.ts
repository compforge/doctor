import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createServiceCatalog,
  type PluginContext,
  type PluginDefinition,
} from "@compforge/doctor-plugin";
import { runCollectData } from "../src/collect/data";
import type { Executor } from "../src/infra/k8s/executor";

const service = "sample-api";
const plugin = {
  id: "sample",
  version: "0.0.1",
  services: createServiceCatalog([{
    name: service,
    capabilities: {
      data: {
        access: {},
        provides: ["sample-record"],
        inspectTarget: async () => ({
          endpoint: "http://sample-api",
          database: "sample",
          username: "reader",
          credentialSource: "test",
        }),
        inspect: async (_context, { inputId }) => ({
          kind: "sample-record",
          service,
          resolution: { inputId, resolvedAs: "sample_id" },
        }),
        summarize: (result) => ({
          resolvedAs: result.resolution.resolvedAs,
          identifiers: { sample_id: result.resolution.inputId },
        }),
        detect: () => [],
      },
    },
  }]),
} satisfies PluginDefinition;

const executor: Executor = {
  run: async () => { throw new Error("unexpected Kubernetes access"); },
  exec: async () => { throw new Error("unexpected Kubernetes access"); },
};
const contexts = { [service]: {} as PluginContext };

test("doctor data JSON 写入文件，stdout 只报告文件路径", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-data-json-output-"));
  const requestedOutput = join(root, "result");
  const outputPath = `${requestedOutput}.json`;
  const write = spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    expect(await runCollectData({
      bizIds: ["biz-1"],
      services: service,
      config: join(root, "missing-config.yaml"),
      format: "json",
      output: requestedOutput,
    }, plugin, executor, contexts)).toBe(0);

    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toMatchObject({
      evidence: {
        observations: [{
          service,
          result: { resolution: { inputId: "biz-1", resolvedAs: "sample_id" } },
        }],
      },
    });
    const stdout = write.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(stdout).toContain(`[collect] Data JSON: ${outputPath}`);
    expect(stdout).not.toContain('"evidence"');
  } finally {
    write.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor data 批量 JSON 只写一个 groups 文件", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-data-json-batch-"));
  const outputPath = join(root, "batch.json");
  const write = spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    expect(await runCollectData({
      bizIds: ["biz-1", "biz-2"],
      services: service,
      config: join(root, "missing-config.yaml"),
      format: "json",
      output: outputPath,
    }, plugin, executor, contexts)).toBe(0);

    const report = JSON.parse(readFileSync(outputPath, "utf8"));
    expect(Object.keys(report.groups)).toEqual(["biz-1", "biz-2"]);
    const stdout = write.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(stdout).toContain(`[collect] Data JSON: ${outputPath}`);
    expect(stdout).not.toContain('"groups"');
  } finally {
    write.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
