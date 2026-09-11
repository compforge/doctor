import { createServiceCatalog, type PluginDefinition } from "@compforge/doctor-plugin";
import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { runCollectTrace } from "../src/collect/trace";
import { traceCommand } from "../src/collect/trace/command";
import { CommandContext, CommandStatus } from "../src/command";
import { RenderContext } from "../src/report/context";

for (const ids of [["a"], ["a", "b", "missing"]]) test(`Trace uses list output and per-ID artifacts: ${ids}`, async () => {
  const queries: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    const path = new URL(request.url).pathname;
    if (path === "/") return Response.json({ version: { number: "2.0.0" } });
    const body = await request.json() as { query: { term: { traceID: string } } };
    const traceId = body.query.term.traceID;
    if (path.endsWith("/_count")) { queries.push(traceId); return Response.json({ count: 1 }); }
    if (path.endsWith("/_search")) return Response.json({ hits: { hits: [
      { _source: { traceID: traceId, spanID: "s1", operationName: `op-${traceId}` }, sort: [1] },
    ] } });
    return new Response("unexpected request", { status: 500 });
  } });
  const plugin: PluginDefinition = { id: "test", version: "1", services: createServiceCatalog([{
    name: "api", workloads: [], capabilities: { traceId: { endpoint: { host: "test", port: 80 }, access: {}, resolve: async (_ctx, { bizId }) =>
      bizId === "missing" ? undefined : { traceId: bizId, resolvedAs: "trace_id" } } },
  }]) };
  const context = new CommandContext({ kubernetes: {
    kubeconfig: { source: "test" }, channel: { available: true, client: {
      ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 0, timedOut: false, command: [],
    } },
  } });
  try {
    const result = await runCollectTrace({ bizIds: ids, namespace: "test", endpoint: server.url.href, pageSize: "100" }, plugin, context);
    expect(result.status).toBe(ids.length === 1 ? CommandStatus.Ok : CommandStatus.Partial);
    expect(queries).toEqual(ids.filter(id => id !== "missing"));
    const items = result.output!.items;
    expect(items.map(item => item.bizId)).toEqual(ids);
    for (const item of items) {
      expect(item.status).toBe(item.bizId === "missing" ? CommandStatus.Failed : CommandStatus.Ok);
      expect(item.artifacts).toHaveLength(item.bizId === "missing" ? 0 : 1);
      for (const artifact of item.artifacts) {
        expect(existsSync(join(artifact.path, "report.html"))).toBeFalse();
        expect(JSON.parse(readFileSync(join(artifact.path, "manifest.json"), "utf8")).target.input_id).toBe(item.bizId);
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
