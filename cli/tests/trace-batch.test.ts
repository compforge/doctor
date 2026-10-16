import { traceExtension } from "../../packages/plugin/tests/extension-fixture";
import { createServiceCatalog, type PluginDefinition } from "@compforge/doctor-plugin";
import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { runCollectTrace } from "../src/collect/trace";
import { traceCommand } from "../src/collect/trace/command";
import { CommandContext, CommandStatus } from "../src/command";
import { RenderContext } from "../src/report/context";

const directTraceId = "0d41ecb03911d142001fc668034ffc74";
const resolvedTraceId = (id: string) => id === directTraceId ? id : `trace-${id}`;

for (const ids of [["a"], ["a", "b", "missing"], [directTraceId]]) test(`Trace uses list output and per-ID artifacts: ${ids}`, async () => {
  const queries: string[] = [];
  const resolvedInputs: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, fetch: async request => {
      const path = new URL(request.url).pathname;
      if (path === "/") return Response.json({ version: { number: "2.0.0" } });
      if (request.method === "GET") return new Response("health permission denied", { status: 403 });
      const body = await request.json() as { query: { term: { traceID: string } } };
      const traceId = body.query.term.traceID;
      if (path.endsWith("/_count")) { queries.push(traceId); return Response.json({ count: 1 }); }
      if (path.endsWith("/_search")) return Response.json({
        hits: {
          hits: [
            { _source: { traceID: traceId, spanID: "s1", operationName: `op-${traceId}` }, sort: [1] },
          ]
        }
      });
      return new Response("unexpected request", { status: 500 });
    }
  });
  const plugin: PluginDefinition = {
    id: "test", version: "1", services: createServiceCatalog([{
      component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
      name: "api",
      workloads: [],
      extensions: [traceExtension({
        endpoint: { host: "test", port: 80 }, access: {}, resolve: async (_ctx, { bizId }) => {
          resolvedInputs.push(bizId);
          return bizId === "missing" ? undefined : { traceId: resolvedTraceId(bizId),
            resolvedAs: bizId === directTraceId ? "trace_id" : "message_id", sourceId: bizId };
        }
      })]
    }])
  };
  const context = new CommandContext({
    kubernetes: {
      kubeconfig: { source: "test" }, channel: {
        available: true, client: {
          ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 0, timedOut: false, command: [],
        }
      },
    }
  });
  try {
    const result = await runCollectTrace({ bizIds: ids, namespace: "test", endpoint: server.url.href, pageSize: "100" }, plugin, context);
    expect(result.status).toBe(ids.length === 1 ? CommandStatus.Ok : CommandStatus.Partial);
    expect(resolvedInputs).toEqual(ids);
    expect(queries).toEqual(ids.filter(id => id !== "missing").map(resolvedTraceId));
    const items = result.output!.items;
    expect(items.map(item => item.bizId)).toEqual(ids);
    for (const item of items) {
      expect(item.status).toBe(item.bizId === "missing" ? CommandStatus.Failed : CommandStatus.Ok);
      expect(item.artifacts).toHaveLength(item.bizId === "missing" ? 0 : 1);
      for (const artifact of item.artifacts) {
        expect(existsSync(join(artifact.path, "report.html"))).toBeFalse();
        expect(JSON.parse(readFileSync(join(artifact.path, "collection.json"), "utf8")).target.input_id).toBe(item.bizId);
        expect(JSON.parse(readFileSync(join(artifact.path, "tree.json"), "utf8")).trace_id).toBe(resolvedTraceId(item.bizId));
        if (item.bizId === directTraceId) {
          expect(readFileSync(join(artifact.path, "summary.md"), "utf8")).toContain("输入 trace ID: `" + directTraceId + "`");
        }
      }
    }
    expect(new Set(items.flatMap(item => item.artifacts.map(artifact => artifact.id))).size).toBe(queries.length);
    const summary = result.artifacts[0]!;
    expect(existsSync(join(summary.path, "report.html"))).toBeFalse();
    const renderer = new RenderContext(result.artifacts, "test");
    const report = await renderer.render(traceCommand, result);
    expect(renderer.failures).toHaveLength(0);
    expect(report.sections[0]!.pages.map(page => page.subject?.key)).toEqual(ids);
    for (const item of items) for (const artifact of item.artifacts) expect(existsSync(join(artifact.path, "report.html"))).toBeTrue();
    const saved = JSON.parse(readFileSync(join(summary.path, "diagnosis.json"), "utf8"));
    expect(saved.items.map((item: { bizId: string }) => item.bizId)).toEqual(ids);
  } finally {
    await context.disposeClients(); server.stop(true);
    for (const root of new Set(context.artifacts.list().map(artifact => dirname(artifact.path)))) rmSync(root, { recursive: true, force: true });
  }
});

test("online span rejects a biz-id resolving multiple traces before any span download", async () => {
  let remoteReads = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, fetch: () => {
      remoteReads++;
      return Response.json({});
    }
  });
  const plugin: PluginDefinition = {
    id: "test", version: "1", services: createServiceCatalog([{
      component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
      name: "api",
      workloads: [],
      extensions: [traceExtension({
        endpoint: { host: "test", port: 80 }, access: {},
        resolve: async () => ["t1", "t2"].map(traceId => ({ traceId, resolvedAs: "conversation_id" }))
      })]
    }])
  };
  const context = new CommandContext({
    kubernetes: {
      kubeconfig: { source: "test" }, channel: {
        available: true, client: {
          ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 0, timedOut: false, command: [],
        }
      },
    }
  });
  try {
    const result = await runCollectTrace({
      bizIds: ["conversation"], span: "shared-span-id", namespace: "test",
      endpoint: server.url.href, pageSize: "100"
    }, plugin, context);
    expect(result.status).toBe(CommandStatus.Failed);
    if (result.status === CommandStatus.Failed) expect(result.reason).toContain("多条 trace");
    expect(remoteReads).toBe(0);
    expect(result.artifacts).toHaveLength(0);
  } finally { await context.disposeClients(); server.stop(true); }
});

for (const resolved of [true, false]) test(`Trace preserves health evidence with no spans or unresolved ID: ${resolved}`, async () => {
  let healthReads = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
    const path = new URL(request.url).pathname;
    if (path === "/") return Response.json({ version: { number: "2.0.0" } });
    if (path === "/_cluster/health") { healthReads++; return Response.json({ status: "red", unassigned_shards: 1 }); }
    if (path === "/_cat/allocation") return Response.json([{ node: "data-0", "disk.used": 93,
      "disk.avail": 7, "disk.total": 100, "disk.percent": 93 }]);
    if (path === "/_cluster/settings") return Response.json({ defaults: {
      "cluster.routing.allocation.disk.watermark.low": "85%", "cluster.routing.allocation.disk.watermark.high": "90%",
      "cluster.routing.allocation.disk.watermark.flood_stage": "95%" } });
    if (path === "/_cat/shards") return Response.json([{ state: "UNASSIGNED", prirep: "p" }]);
    if (path.endsWith("/_count")) return Response.json({ count: 0 });
    return Response.json({});
  } });
  const plugin: PluginDefinition = { id: "test", version: "1", services: createServiceCatalog([{
    name: "api", workloads: [],
    component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
    dataSources: [{ id: "trace", kind: "vdb", backend: "opensearch", store: "opensearch" }],
    dependencies: [{ id: "trace-store", service: "api", dataSource: "trace" }],
    extensions: [traceExtension({ endpoint: { host: "test", port: 80 }, access: {}, resolve: async () => resolved ? { traceId: "trace-1", resolvedAs: "message_id" } : undefined })],
  }]) };
  const context = new CommandContext({ kubernetes: { kubeconfig: { source: "test" }, channel: {
    available: true, client: { ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 0, timedOut: false, command: [] },
  } } });
  let serialized: string | undefined;
  try {
    const result = await runCollectTrace({ bizIds: ["a"], namespace: "test", endpoint: server.url.href, pageSize: "100" }, plugin, context);
    expect(result.status).toBe(CommandStatus.Failed);
    expect(healthReads).toBe(1);
    const artifacts = result.artifacts.filter(artifact => artifact.command === "datasource-health");
    expect(artifacts).toHaveLength(1);
    const health = JSON.parse(readFileSync(join(artifacts[0]!.path, "health.json"), "utf8")).health;
    expect(health.findings.map((finding: { kind: string }) => finding.kind)).toContain("vdb.disk-capacity-high");
    const { SerializeContext } = await import("../src/command/serialization/context");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    serialized = mkdtempSync(join(tmpdir(), "trace-health-serialization-"));
    const output = await SerializeContext.create(serialized, traceCommand, result);
    expect(output.failed).toBe(false);
    expect(JSON.parse(readFileSync(join(serialized, "views.json"), "utf8")).data_sources).toHaveLength(1);
    expect(readFileSync(join(serialized, "views.txt"), "utf8")).toContain("high 水位 90%");
    const renderer = new RenderContext(result.artifacts, "test");
    const report = await renderer.render(traceCommand, result);
    expect(renderer.failures).toHaveLength(0);
    expect(report.sections.find(section => section.id === "datasource-health")?.pages).toHaveLength(1);
  } finally {
    await context.disposeClients(); server.stop(true);
    for (const artifact of context.artifacts.list()) rmSync(artifact.path, { recursive: true, force: true });
    if (serialized) rmSync(serialized, { recursive: true, force: true });
  }
});
