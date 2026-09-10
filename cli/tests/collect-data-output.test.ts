import { inspectIndividually } from "@compforge/doctor-plugin";
import { readBundleIndex, readBundleText } from "./bundle-fixture";
import { commandExitCode } from "../src/app/command";
import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createServiceCatalog,
  type PluginContext,
  type PluginDefinition,
} from "@compforge/doctor-plugin";
import {
  dataServicesForBizQuery,
  prepareDataCommand,
  runCollectData,
} from "../src/collect/data";
import { CommandContext } from "../src/command";
import type { Executor } from "@compforge/doctor-toolkit/kubernetes/executor";
import { deliverCommandArtifacts } from "../src/app/delivery";

const service = "sample-api";
const plugin = {
  id: "sample",
  version: "0.0.1",
  services: createServiceCatalog([{
    name: service,
    workloads: [],
    contributions: {
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
      inspect: {
        access: {},
        accepts: ["biz_id"],
        provides: ["sample-record"],
        resolveTarget: async () => ({
          endpoint: "http://sample-api",
          database: "sample",
          username: "reader",
          credentialSource: "test",
        }),
        inspect: inspectIndividually(async (_context, query) => ({
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
        })),
      },
    },
    capabilities: {},
  }]),
} satisfies PluginDefinition;

const executor: Executor = {
  run: async () => { throw new Error("unexpected Kubernetes access"); },
  exec: async () => { throw new Error("unexpected Kubernetes access"); },
};
const contexts = { [service]: {} as PluginContext };

test("doctor data 默认不选择仅接受 tenant_id 的 capability", () => {
  const tenantOnly = {
    name: "tenant-api",
    workloads: [],
    contributions: {
      inspect: {
        access: {},
        accepts: ["tenant_id"],
        provides: ["tenant-record"],
        resolveTarget: async () => ({
          endpoint: "http://tenant-api",
          database: "tenant",
          username: "reader",
          credentialSource: "test",
        }),
        inspect: inspectIndividually(async (_context, query) => ({
          resolution: {
            inputId: query.identity.value,
            resolvedAs: query.identity.kind,
            identifiers: {},
          },
          facts: [{ factType: "value", kind: "tenant-record", schemaVersion: 1, value: {} }],
        })),
      },
    },
    capabilities: {},
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
      // Deliberately declared first: it can only run after the later resolver discovers message_id.
      name: traceResolver,
      workloads: [],
      contributions: {
        inspect: {
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
          inspect: inspectIndividually(async (_context, query) => ({
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
          })),
        },
      },
      capabilities: {},
    }, {
      name: resolver,
      workloads: [],
      contributions: {
        inspect: {
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
          inspect: inspectIndividually(async (_context, query) => {
            const identity = query.identity;
            return {
              resolution: { inputId: identity.value, resolvedAs: identity.kind, identifiers: {} },
              facts: [{ factType: "value", kind: "resolution-record", schemaVersion: 1, value: {} },
                ...(identity.kind === "biz_id" ? [{
                  factType: "relation" as const,
                    kind: "resolves-to",
                    schemaVersion: 1,
                    from: identity,
                    to: { kind: "message_id", value: "message-1" },
                  }] : [])],
            };
          }),
        },
      },
      capabilities: {},
    }, {
      name: records,
      workloads: [],
      contributions: {
        inspect: {
          access: {},
          accepts: ["trace_id"],
          provides: ["sample-record"],
          resolveTarget: async () => ({
            endpoint: "http://sample-records",
            database: "sample",
            username: "reader",
            credentialSource: "test",
          }),
          inspect: inspectIndividually(async (_context, query) => {
            const identity = query.identity;
            seen.push(`${identity.kind}:${identity.value}`);
            return {
              resolution: { inputId: identity.value, resolvedAs: identity.kind, identifiers: {} },
              facts: [{ factType: "value", kind: "sample-record", schemaVersion: 1, value: {} }],
            };
          }),
        },
      },
      capabilities: {},
    }]),
  } satisfies PluginDefinition;

  try {
    const context = new CommandContext({});
    const code = await runCollectData({
      bizIds: ["biz-1"],
      services: `${traceResolver},${resolver},${records}`,
      namespace: "vke-system",
      format: "json",
      output: join(root, "result.json"),
    }, relationPlugin, context, executor, {
      [resolver]: {} as PluginContext,
      [traceResolver]: {} as PluginContext,
      [records]: {} as PluginContext,
    });

    expect(commandExitCode(code)).toBe(0);
    expect(await deliverCommandArtifacts(
      context,
      { format: "json", output: join(root, "result.json") },
      commandExitCode(code),
      "doctor data",
    )).toBe(true);
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
    const code = await runCollectData({
      bizIds: ["biz-1"],
      services: service,
      config: join(root, "missing-config.yaml"),
      format: "json",
      output: requestedOutput,
    }, plugin, context, executor, contexts);
    expect(commandExitCode(code)).toBe(0);
    expect(await deliverCommandArtifacts(context, { format: "json", output: requestedOutput }, commandExitCode(code), "doctor data"))
      .toBe(true);

    const delivered = JSON.parse(readFileSync(outputPath, "utf8"));
    expect(delivered.artifacts).toHaveLength(2);
    const report = delivered.artifacts[1].diagnosis;
    expect(delivered.artifacts[0].diagnosis.groups).toEqual({ "biz-1": report });
    expect(report).toMatchObject({
      evidence: {
        observations: [],
        facts: {
          capabilityResults: [{
            status: "collected",
            service,
            result: {
              resolution: { inputId: "biz-1", resolvedAs: "sample_id" },
              facts: [{ factType: "record", recordKey: "one" }, { factType: "record", recordKey: "two" }],
            },
          }],
        },
      },
      findings: [{
        id: `service-detector:${service}:sample-records:sample-record-collected`,
        evidence: [
          { factPath: "capabilityResults.0.result.facts.0", role: "supporting" },
          { factPath: "capabilityResults.0.result.facts.1", role: "supporting" },
        ],
      }],
    });
    expect(report.evidence.facts.capabilityResults.map((result: { id: string }) => result.id)).toEqual([
      `data-query:provide:${service}:biz_id:biz-1`,
    ]);
    const stdout = write.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(stdout).toContain(`[delivery] JSON 报告: ${outputPath}`);
    expect(stdout).not.toContain('"evidence"');
  } finally {
    write.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor data 批量 JSON 保留汇总和各 biz-id 的 Artifact 身份", async () => {
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
    expect(commandExitCode(code)).toBe(0);
    expect(await deliverCommandArtifacts(context, { format: "json", output: outputPath }, commandExitCode(code), "doctor data"))
      .toBe(true);

    const report = JSON.parse(readFileSync(outputPath, "utf8"));
    expect(report.artifacts).toHaveLength(3);
    expect(new Set(report.artifacts.map((artifact: { id: string }) => artifact.id)).size).toBe(3);
    expect(report.artifacts.map((artifact: { command: string }) => artifact.command)).toEqual(["data", "data", "data"]);
    expect(Object.keys(report.artifacts[0].diagnosis.groups)).toEqual(["biz-1", "biz-2"]);
    expect(report.artifacts[1].diagnosis).toEqual(report.artifacts[0].diagnosis.groups["biz-1"]);
    expect(report.artifacts[2].diagnosis).toEqual(report.artifacts[0].diagnosis.groups["biz-2"]);
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
    expect(commandExitCode(code)).toBe(0);
    expect(await deliverCommandArtifacts(context, { output }, commandExitCode(code), "doctor data")).toBe(true);

    expect(existsSync(htmlPath)).toBe(true);
    expect(existsSync(bundlePath)).toBe(true);
    const listing = Bun.spawnSync(["tar", "-tzf", bundlePath]).stdout.toString();
    const entries = listing.split(/\r?\n/).filter(Boolean);
    expect([...new Set(entries.map((entry) => entry.split("/")[0]))]).toEqual(["report"]);
    expect(entries).toContain("report/AGENTS.md");
    const index = readBundleIndex(bundlePath, "report");
    const data = index.artifacts.find(artifact => artifact.command === "data")!;
    expect(entries).toContain(`report/${data.report}`);
    expect(listing).toContain("/report.html");
    expect(listing).toContain("/diagnosis.json");
    expect(listing).toContain("/manifest.json");
    expect(listing).toContain("/raw/");
    const manifest = JSON.parse(
      readBundleText(bundlePath, `report/${data.path}/manifest.json`),
    );
    expect(manifest.params.inspect_capabilities).toMatchObject({ [service]: { provides: ["sample-record"], expands: [] } });
    expect(manifest.params).not.toHaveProperty("data_capabilities");
    expect(manifest.inspection_facts.capabilityResults).toMatchObject([
      { status: "collected", service, result: { facts: [{ recordKey: "one" }, { recordKey: "two" }] } },
    ]);
    const agents = Bun.spawnSync(["tar", "-xOf", bundlePath, "report/AGENTS.md"]).stdout.toString();
    expect(agents).toContain(`\`${data.report}\``);
  } finally {
    write.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
