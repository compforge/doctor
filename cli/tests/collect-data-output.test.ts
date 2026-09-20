import { inspectExtension } from "../../packages/plugin/tests/extension-fixture";
import {
  createServiceCatalog,
  type PluginContext,
  type PluginDefinition,
} from "@compforge/doctor-plugin";
import type { Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { commandExitCode } from "../src/app/command";
import { finalizeResult } from "./report-fixture";
import {
  dataServicesForBizQuery,
  prepareDataCommand,
  runCollectData,
} from "../src/collect/data";
import { dataCommand } from "../src/collect/data/command";
import { CommandContext } from "../src/command";
import { readBundleIndex, readBundleText } from "./bundle-fixture";

const service = "sample-api";
const plugin = {
  id: "sample",
  version: "0.0.1",
  services: createServiceCatalog([{
    component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
    name: service,
    workloads: [],
    detectors: [{
      id: "sample-records",
      detect: (evidence) => {
        const facts = evidence.facts.filter((item) => item.services.includes(service));
        return facts.length ? [{
          id: "sample-record-collected",
          kind: "record-collected",
          schemaVersion: 1,
          severity: "info",
          confidence: "high",
          message: `collected ${facts[0]!.query!.value}`,
          evidence: facts.map((item) => ({
            factPath: item.factPath,
            role: "supporting" as const,
          })),
        }] : [];
      },
    }],
    extensions: [inspectExtension({
      access: {},
      accepts: ["biz_id"],
      provides: ["sample-record"],
      resolveTarget: async () => ({
        endpoint: "http://sample-api",
        database: "sample",
        username: "reader",
        credentialSource: "test",
      }),
      inspect: async (_context, queries) => queries.map(query => ({
        identity: query.identity, status: "collected" as const, result: {
          resolution: {
            inputId: query.identity.value,
            resolvedAs: "sample_id",
            identifiers: { sample_id: query.identity.value },
          },
          facts: ["one", "two"].map((recordId) => ({
            factType: "record" as const,
            kind: "sample-record",
            schemaVersion: 1,
            recordKey: recordId,
            record: { id: recordId },
          })),
        },
      })),
    })]
  }]),
} satisfies PluginDefinition;

const executor: Executor = {
  run: async () => { throw new Error("unexpected Kubernetes access"); },
  exec: async () => { throw new Error("unexpected Kubernetes access"); },
};
const contexts = { [service]: { signal: new AbortController().signal } as PluginContext };

test("doctor data 默认不选择仅接受 tenant_id 的 capability", () => {
  const tenantOnly = {
    component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
    name: "tenant-api",
    workloads: [],
    extensions: [inspectExtension({
      access: {},
      accepts: ["tenant_id"],
      provides: ["tenant-record"],
      resolveTarget: async () => ({
        endpoint: "http://tenant-api",
        database: "tenant",
        username: "reader",
        credentialSource: "test",
      }),
      inspect: async (_context, queries) => queries.map(query => ({
        identity: query.identity, status: "collected" as const, result: {
          resolution: {
            inputId: query.identity.value,
            resolvedAs: query.identity.kind,
            identifiers: {},
          },
          facts: [{ factType: "value", kind: "tenant-record", schemaVersion: 1, value: {} }],
        },
      })),
    })]
  } satisfies PluginDefinition["services"]["services"][number];

  expect(dataServicesForBizQuery(createServiceCatalog([
    ...plugin.services.services,
    tenantOnly,
  ]))).toEqual([service]);
});

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

test("doctor data Relation work queue 不依赖 Catalog 顺序，也不读取 summary identifier", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-data-relations-"));
  const seen: string[] = [];
  const resolver = "sample-resolver";
  const traceResolver = "trace-resolver";
  const records = "sample-records";
  const relationPlugin = {
    id: "sample-relations",
    version: "0.0.1",
    services: createServiceCatalog([{
      component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
      name: traceResolver,
      workloads: [],
      extensions: [inspectExtension({
        access: {},
        accepts: ["message_id"],
        provides: ["trace-resolution"],
        expands: ["trace_id"],
        resolveTarget: async () => ({
          endpoint: "http://trace-resolver",
          database: "sample",
          username: "reader",
          credentialSource: "test",
        }),
        inspect: async (_context, queries) => queries.map(query => ({
          identity: query.identity, status: "collected" as const, result: {
            resolution: {
              inputId: query.identity.value,
              resolvedAs: query.identity.kind,
              identifiers: {},
            },
            facts: [{ factType: "value", kind: "trace-resolution", schemaVersion: 1, value: {} }, {
              factType: "relation",
              kind: "resolves-to",
              schemaVersion: 1,
              from: query.identity,
              to: { kind: "trace_id", value: "trace-1" },
            }],
          },
        })),
      })]
    }, {
      component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
      name: resolver,
      workloads: [],
      extensions: [inspectExtension({
        access: {},
        accepts: ["biz_id"],
        provides: ["resolution-record"],
        expands: ["message_id"],
        resolveTarget: async () => ({
          endpoint: "http://sample-resolver",
          database: "sample",
          username: "reader",
          credentialSource: "test",
        }),
        inspect: async (_context, queries) => queries.map(query => {
          const identity = query.identity;
          return {
            identity: query.identity, status: "collected" as const, result: {
              resolution: { inputId: identity.value, resolvedAs: identity.kind, identifiers: {} },
              facts: [{ factType: "value", kind: "resolution-record", schemaVersion: 1, value: {} },
              ...(identity.kind === "biz_id" ? [{
                factType: "relation" as const,
                kind: "resolves-to",
                schemaVersion: 1,
                from: identity,
                to: { kind: "message_id", value: "message-1" },
              }] : [])],
            }
          };
        }),
      })]
    }, {
      component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
      name: records,
      workloads: [],
      extensions: [inspectExtension({
        access: {},
        accepts: ["trace_id"],
        provides: ["sample-record"],
        resolveTarget: async () => ({
          endpoint: "http://sample-records",
          database: "sample",
          username: "reader",
          credentialSource: "test",
        }),
        inspect: async (_context, queries) => queries.map(query => {
          const identity = query.identity;
          seen.push(`${identity.kind}:${identity.value}`);
          return {
            identity: query.identity, status: "collected" as const, result: {
              resolution: { inputId: identity.value, resolvedAs: identity.kind, identifiers: {} },
              facts: [{ factType: "value", kind: "sample-record", schemaVersion: 1, value: {} }],
            }
          };
        }),
      })]
    }]),
  } satisfies PluginDefinition;

  try {
    const context = new CommandContext({});
    const prepared = await prepareDataCommand({
      bizIds: ["biz-1"],
      services: `${traceResolver},${resolver},${records}`,
      namespace: "vke-system",
      format: "json",
      output: join(root, "result.json"),
    }, relationPlugin.services, context, executor);
    expect(prepared).toBeDefined();
    const code = await runCollectData(prepared!, relationPlugin, {
      [resolver]: { signal: new AbortController().signal } as PluginContext,
      [traceResolver]: { signal: new AbortController().signal } as PluginContext,
      [records]: { signal: new AbortController().signal } as PluginContext,
    });

    expect(commandExitCode(code)).toBe(0);
    expect(await finalizeResult(context, dataCommand, code, { format: "json", output: join(root, "result.json") })).toBe(0);
    expect(seen).toEqual(["trace_id:trace-1"]);
    expect(seen).not.toContain("message_id:presentation-only");
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
    const prepared = await prepareDataCommand({
      bizIds: ["biz-1"],
      services: service,
      config: join(root, "missing-config.yaml"),
      format: "json",
      output: requestedOutput,
    }, plugin.services, context, executor);
    expect(prepared).toBeDefined();
    const code = await runCollectData(prepared!, plugin, contexts);
    expect(commandExitCode(code)).toBe(0);
    expect(await finalizeResult(context, dataCommand, code, { format: "json", output: requestedOutput }))
      .toBe(0);

    const delivered = JSON.parse(readFileSync(outputPath, "utf8"));
    const manifest = JSON.parse(readFileSync(delivered.manifest, "utf8"));
    const facts = JSON.parse(readFileSync(join(dirname(delivered.manifest), manifest.files.facts.path), "utf8"));
    expect(delivered.result.items).toHaveLength(1);
    const report = delivered.result.items[0];
    expect(report).toMatchObject({
      bizId: "biz-1", findings: [{
        id: `service-detector:${service}:sample-records:sample-record-collected`,
        evidence: [
          { factPath: "capabilityResults.0.result.facts.0", role: "supporting" },
          { factPath: "capabilityResults.0.result.facts.1", role: "supporting" },
        ],
      }]
    });
    expect(report).not.toHaveProperty("evidence");
    expect(facts.capabilityResults).toMatchObject([{
      status: "collected", service,
      result: {
        resolution: { inputId: "biz-1", resolvedAs: "sample_id" },
        facts: [{ factType: "record", recordKey: "one" }, { factType: "record", recordKey: "two" }]
      },
    }]);
    expect(report.selection.queryIds).toEqual([`data-query:provide:${service}:biz_id:biz-1`]);
    expect(facts.capabilityResults.map((query: { id: string }) => query.id)).toEqual(report.selection.queryIds);
    const stdout = write.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(stdout).toContain(`[delivery] diagnosis.json: ${outputPath}`);
    expect(stdout).not.toContain('"evidence"');
  } finally {
    write.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor data 批量 JSON 保留各 biz-id 的选择和覆盖度，Facts 只保存一份", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-data-json-batch-"));
  const outputPath = join(root, "batch.json");
  const write = spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    const context = new CommandContext({});
    const prepared = await prepareDataCommand({
      bizIds: ["biz-1", "biz-2"],
      services: service,
      config: join(root, "missing-config.yaml"),
      format: "json",
      output: outputPath,
    }, plugin.services, context, executor);
    expect(prepared).toBeDefined();
    const code = await runCollectData(prepared!, plugin, contexts);
    expect(commandExitCode(code)).toBe(0);
    expect(await finalizeResult(context, dataCommand, code, { format: "json", output: outputPath }))
      .toBe(0);

    const report = JSON.parse(readFileSync(outputPath, "utf8"));
    expect(report.result.items.map((item: { bizId: string }) => item.bizId)).toEqual(["biz-1", "biz-2"]);
    const manifest = JSON.parse(readFileSync(report.manifest, "utf8"));
    expect(manifest.children).toEqual([]);
    const facts = JSON.parse(readFileSync(join(dirname(report.manifest), manifest.files.facts.path), "utf8"));
    for (const item of report.result.items) {
      expect(item.selection.queryIds).toEqual([`data-query:provide:${service}:biz_id:${item.bizId}`]);
      expect(item.coverage).toEqual(expect.any(Array));
      for (const id of item.selection.queryIds) expect(facts.capabilityResults.some((query: { id: string }) => query.id === id)).toBe(true);
      expect(item).not.toHaveProperty("evidence");
    }
    const stdout = write.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(stdout).toContain(`[delivery] diagnosis.json: ${outputPath}`);
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
    const prepared = await prepareDataCommand({
      bizIds: ["biz-1"],
      services: service,
      config: join(root, "missing-config.yaml"),
      output,
    }, plugin.services, context, executor);
    expect(prepared).toBeDefined();
    const code = await runCollectData(prepared!, plugin, contexts);
    expect(commandExitCode(code)).toBe(0);
    expect(await finalizeResult(context, dataCommand, code, { output })).toBe(0);

    expect(existsSync(htmlPath)).toBe(true);
    expect(existsSync(bundlePath)).toBe(true);
    const listing = Bun.spawnSync(["tar", "-tzf", bundlePath]).stdout.toString();
    const entries = listing.split(/\r?\n/).filter(Boolean);
    expect([...new Set(entries.map((entry) => entry.split("/")[0]))]).toEqual(["report"]);
    expect(entries).toContain("report/AGENTS.md");
    const index = readBundleIndex(bundlePath, "report");
    expect(index.command).toBe("data");
    expect(index.children).toEqual([]);
    expect(entries).toContain(`report/${index.files.report!.path}`);
    expect(entries).toContain(`report/${index.files.diagnosis!.path}`);
    expect(entries).toContain(`report/${index.files.facts!.path}`);
    const manifest = JSON.parse(readBundleText(bundlePath, "report/manifest.json"));
    expect(manifest.params.inspect_capabilities).toMatchObject({ [service]: { provides: ["sample-record"], expands: [] } });
    expect(manifest.params).not.toHaveProperty("data_capabilities");
    expect(JSON.parse(readBundleText(bundlePath, `report/${manifest.files.facts.path}`)).capabilityResults).toMatchObject([
      { status: "collected", service, result: { facts: [{ recordKey: "one" }, { recordKey: "two" }] } },
    ]);
    const agents = Bun.spawnSync(["tar", "-xOf", bundlePath, "report/AGENTS.md"]).stdout.toString();
    expect(agents).toContain("`report.html`");
  } finally {
    write.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
