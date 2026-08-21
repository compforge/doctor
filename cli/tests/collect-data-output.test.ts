import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createServiceCatalog,
  type PluginContext,
  type PluginDefinition,
} from "@compforge/doctor-plugin";
import { prepareDataCommand, runCollectData } from "../src/collect/data";
import { CommandContext } from "../src/command";
import type { Executor } from "../src/infra/k8s/executor";
import { deliverCommandArtifacts } from "../src/app/delivery";

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

test("DataCommandContext 聚合调用方提供的 CommandContext", async () => {
  const command = new CommandContext({});
  const context = await prepareDataCommand({
    bizIds: ["biz-1"],
    services: service,
    namespace: "vke-system",
    format: "json",
  }, plugin.services, command, executor);

  expect(context?.command).toBe(command);
  expect(context?.executor).toBe(executor);
  expect(context?.config.namespace).toBe("vke-system");
});

test("doctor data 优先用 capability Relation 扩展 Query，并保留旧 summary 回退", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-data-relations-"));
  const seen: string[] = [];
  const resolver = "sample-resolver";
  const records = "sample-records";
  const relationPlugin = {
    id: "sample-relations",
    version: "0.0.1",
    services: createServiceCatalog([{
      name: resolver,
      capabilities: {
        data: {
          access: {},
          provides: ["resolution-record"],
          expands: ["message_id"],
          inspectTarget: async () => ({
            endpoint: "http://sample-resolver",
            database: "sample",
            username: "reader",
            credentialSource: "test",
          }),
          inspect: async (_context, query) => {
            const identity = query.identities[0]!;
            return {
              kind: "resolution-record",
              service: resolver,
              resolution: { inputId: identity.value, resolvedAs: identity.kind },
              relations: identity.value === "biz-legacy"
                ? undefined
                : identity.kind === "biz_id" ? [{
                    kind: "resolves-to",
                    from: identity,
                    to: { kind: "message_id", value: "message-1" },
                  }] : [],
            };
          },
          summarize: (result) => ({
            resolvedAs: result.resolution.resolvedAs,
            identifiers: {
              message_id: result.resolution.inputId === "biz-legacy"
                ? "message-legacy"
                : "presentation-only",
            },
          }),
          detect: () => [],
        },
      },
    }, {
      name: records,
      capabilities: {
        data: {
          access: {},
          provides: ["sample-record"],
          inspectTarget: async () => ({
            endpoint: "http://sample-records",
            database: "sample",
            username: "reader",
            credentialSource: "test",
          }),
          inspect: async (_context, query) => {
            const identity = query.identities[0]!;
            seen.push(`${identity.kind}:${identity.value}`);
            return {
              kind: "sample-record",
              service: records,
              resolution: { inputId: identity.value, resolvedAs: identity.kind },
            };
          },
          summarize: (result) => ({
            resolvedAs: result.resolution.resolvedAs,
            identifiers: {},
          }),
          detect: () => [],
        },
      },
    }]),
  } satisfies PluginDefinition;

  try {
    const context = new CommandContext({});
    const code = await runCollectData({
      bizIds: ["biz-1", "biz-legacy"],
      services: `${resolver},${records}`,
      namespace: "vke-system",
      format: "json",
      output: join(root, "result.json"),
    }, relationPlugin, context, executor, {
      [resolver]: {} as PluginContext,
      [records]: {} as PluginContext,
    });

    expect(code).toBe(0);
    expect(await deliverCommandArtifacts(
      context,
      { format: "json", output: join(root, "result.json") },
      code,
      "doctor data",
    )).toBe(true);
    expect(seen).toContain("biz_id:biz-1");
    expect(seen).toContain("message_id:message-1");
    expect(seen).not.toContain("message_id:presentation-only");
    expect(seen).toContain("message_id:message-legacy");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor data JSON 写入文件，stdout 只报告文件路径", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-data-json-output-"));
  const requestedOutput = join(root, "result");
  const outputPath = `${requestedOutput}.json`;
  const write = spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    const context = new CommandContext({});
    const code = await runCollectData({
      bizIds: ["biz-1"],
      services: service,
      config: join(root, "missing-config.yaml"),
      format: "json",
      output: requestedOutput,
    }, plugin, context, executor, contexts);
    expect(code).toBe(0);
    expect(await deliverCommandArtifacts(context, { format: "json", output: requestedOutput }, code, "doctor data"))
      .toBe(true);

    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toMatchObject({
      evidence: {
        observations: [{
          service,
          result: { resolution: { inputId: "biz-1", resolvedAs: "sample_id" } },
        }],
      },
    });
    const stdout = write.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(stdout).toContain(`[delivery] JSON 报告: ${outputPath}`);
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
    const context = new CommandContext({});
    const code = await runCollectData({
      bizIds: ["biz-1", "biz-2"],
      services: service,
      config: join(root, "missing-config.yaml"),
      format: "json",
      output: outputPath,
    }, plugin, context, executor, contexts);
    expect(code).toBe(0);
    expect(await deliverCommandArtifacts(context, { format: "json", output: outputPath }, code, "doctor data"))
      .toBe(true);

    const report = JSON.parse(readFileSync(outputPath, "utf8"));
    expect(Object.keys(report.groups)).toEqual(["biz-1", "biz-2"]);
    const stdout = write.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(stdout).toContain(`[delivery] JSON 报告: ${outputPath}`);
    expect(stdout).not.toContain('"groups"');
  } finally {
    write.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor data 默认输出 HTML 和包含 JSON/Evidence 的 Bundle", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-data-default-output-"));
  const output = join(root, "report.tar.gz");
  const htmlPath = join(root, "report.html");
  const bundlePath = join(root, "report.tar.gz");
  const write = spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    const context = new CommandContext({});
    const code = await runCollectData({
      bizIds: ["biz-1"],
      services: service,
      config: join(root, "missing-config.yaml"),
      output,
    }, plugin, context, executor, contexts);
    expect(code).toBe(0);
    expect(await deliverCommandArtifacts(context, { output }, code, "doctor data")).toBe(true);

    expect(existsSync(htmlPath)).toBe(true);
    expect(existsSync(bundlePath)).toBe(true);
    const listing = Bun.spawnSync(["tar", "-tzf", bundlePath]).stdout.toString();
    const entries = listing.split(/\r?\n/).filter(Boolean);
    expect([...new Set(entries.map((entry) => entry.split("/")[0]))]).toEqual(["report"]);
    expect(entries).toContain("report/AGENTS.md");
    expect(entries).toContain("report/report.html");
    expect(listing).toContain("/report.html");
    expect(listing).toContain("/diagnosis.json");
    expect(listing).toContain("/manifest.json");
    expect(listing).toContain("/raw/");
    const agents = Bun.spawnSync(["tar", "-xOf", bundlePath, "report/AGENTS.md"]).stdout.toString();
    expect(agents).toContain("`report.html`");
  } finally {
    write.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
