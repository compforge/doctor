import { createServiceCatalog, type PluginDefinition } from "@compforge/doctor-plugin";
import { createAgentRunIR } from "@compforge/trace-harness";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandContext, CommandStatus } from "../src/command";
import { traceCommand } from "../src/collect/trace/command";
import { readTraceSnapshot } from "../src/collect/trace/snapshot";
import { RenderContext } from "../src/report/context";
import { traceExtension } from "../../packages/plugin/tests/extension-fixture";

const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function file() {
  const dir = mkdtempSync(join(tmpdir(), "doctor-import-test-"));
  roots.push(dir);
  const path = join(dir, "trace.json");
  writeFileSync(path, JSON.stringify({ data: [{ traceID: "local", spans: [
    { traceID: "local", spanID: "root", operationName: "POST /entry", startTime: 1000000, duration: 20000,
      tags: [{ key: "http.method", value: "POST" }], process: { serviceName: "fixture" } },
    { traceID: "local", spanID: "child", operationName: "tool", startTime: 1001000, duration: 10000,
      references: [{ refType: "CHILD_OF", traceID: "local", spanID: "root" }], process: { serviceName: "fixture" },
      tags: [{ key: "gen_ai.operation.name", value: "execute_tool" }, { key: "gen_ai.tool.name", value: "fixture-tool" }] },
  ] }] }));
  return path;
}

test("local import applies Plugin analysis without preparing online resolution or Kubernetes", async () => {
  let loads = 0, extractions = 0;
  const plugin: PluginDefinition = {
    id: "fixture", version: "1", services: createServiceCatalog([{
      component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixture" } },
      name: "api", workloads: [], extensions: [traceExtension({ endpoint: { host: "unreachable", port: 80 },
        access: {}, resolve: async () => { throw new Error("file import must not resolve IDs"); } })],
    }]),
    trace: { source: { dataSource: { service: "unreachable", dataSource: "absent" } }, analysis: {
      specs: [{ kind: "http", matches: span => span.name === "POST /entry", value: () => "plugin-owned value" }],
      measurementFilter: node => node.node_id === "root",
      agentRunExtractor: { extract: trace => {
        extractions++;
        return createAgentRunIR(trace.trace_id, [{ id: "run", name: "fixture-agent", start_ms: 1000,
          duration_ms: 20, source_node_ids: ["root"], items: [{ kind: "agent-turn", id: "turn", name: "turn",
            start_ms: 1001, duration_ms: 10, items: [{ kind: "tool-call", id: "tool",
              name: "fixture-tool", start_ms: 1001, duration_ms: 10, source_node_ids: ["child"] }] }] }]);
      } },
    } },
  };
  const context = new CommandContext({}, undefined, {
    environment: { kubeconfig: "/definitely-not-a-kubeconfig" },
    loadPlugin: async () => { loads++; return plugin; },
  });
  try {
    const result = await traceCommand.run(context, { bizIds: [], traceFile: file() });
    roots.push(...result.artifacts.map(artifact => artifact.path));
    expect({ status: result.status, reason: result.output?.items[0]?.reason }).toEqual({ status: CommandStatus.Ok, reason: undefined });
    expect(loads).toBe(1);
    expect(extractions).toBe(1);
    expect(context.inspection.kubernetes).toBeUndefined();
    const dir = result.artifacts[0]!.path;
    const snapshot = readTraceSnapshot(dir);
    expect(snapshot.nodes.find(node => node.node_id === "root")?.value).toBe("plugin-owned value");
    expect(snapshot.views.default.rows.items.filter(row => (row.measurements as unknown[])?.length)
      .flatMap(row => row.source_node_ids)).toEqual(["root"]);
    expect(snapshot.views.agent?.rows.items.some(row => row.name === "fixture-tool")).toBeTrue();
    expect(JSON.parse(readFileSync(join(dir, "collection.json"), "utf8")).params.analysis_plugin).toBe("fixture@1");
    const renderer = new RenderContext(result.artifacts, "file");
    const report = await renderer.render(traceCommand, result);
    expect(renderer.failures).toEqual([]);
    expect(report.sections[0]!.pages).toHaveLength(1);
    const html = readFileSync(join(dir, "trace.html"), "utf8");
    expect(html).toContain('data-perspective="default" class="active"');
    expect(html).toContain('data-perspective="agent"');
    expect(extractions).toBe(1);
  } finally { await context.disposeClients(); }
});

test("local import without a configured Plugin retains generic analysis", async () => {
  const context = new CommandContext({});
  try {
    const result = await traceCommand.run(context, { bizIds: [], traceFile: file() });
    roots.push(...result.artifacts.map(artifact => artifact.path));
    expect({ status: result.status, reason: result.output?.items[0]?.reason }).toEqual({ status: CommandStatus.Ok, reason: undefined });
    const snapshot = readTraceSnapshot(result.artifacts[0]!.path);
    expect(snapshot.nodes.some(node => node.kind === "http")).toBeTrue();
    expect(snapshot.views.agent).toBeUndefined();
    expect(context.inspection.kubernetes).toBeUndefined();
    const renderer = new RenderContext(result.artifacts, "file");
    await renderer.render(traceCommand, result);
    expect(renderer.failures).toEqual([]);
    const html = readFileSync(join(result.artifacts[0]!.path, "trace.html"), "utf8");
    expect(html).toContain('data-perspective="default"');
    expect(html).not.toContain('data-perspective="agent"');
  } finally { await context.disposeClients(); }
});
