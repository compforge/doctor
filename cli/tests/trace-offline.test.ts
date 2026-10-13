import { createAgentRunIR } from "@compforge/trace-harness";
import { SerializeContext } from "../src/command/serialization/context";
import { afterEach, expect, spyOn, test } from "bun:test";
import type { SearchEngine } from "@compforge/harness-toolbox/opensearch/types";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectTrace } from "../src/collect/trace";
import { traceCommand, type TraceInput } from "../src/collect/trace/command";
import { readTraceSnapshot } from "../src/collect/trace/snapshot";
import { CommandContext, CommandStatus } from "../src/command";
import { finalizeResult } from "./report-fixture";
import { RenderContext } from "../src/report/context";

const roots: string[] = [];
const root = () => { const path = mkdtempSync(join(tmpdir(), "doctor-trace-test-")); roots.push(path); return path; };
const json = (dir: string, name: string) => JSON.parse(readFileSync(join(dir, name), "utf8"));
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

function rawSpan(id: string, parent?: string) {
  return { traceID: "t1", spanID: id, operationName: id, startTime: 1000000, duration: 20000,
    process: { serviceName: "fixture" }, references: parent ? [{ refType: "CHILD_OF", traceID: "t1", spanID: parent }] : [],
    tags: [{ key: "payload", value: `input/output:${id}` }] };
}

async function fixture(options: { span?: string; partial?: boolean; grouped?: boolean; extracted?: () => void; hiddenMeasurements?: boolean } = {}) {
  const dir = root();
  const spans = options.span ? [rawSpan(options.span)] : [rawSpan("root"), rawSpan("child", "root"), rawSpan("another-root")];
  const queries: unknown[] = [];
  const search: SearchEngine = {
    count: async (_index, query) => { queries.push(query); return spans.length + (options.partial ? 1 : 0); },
    search: async (_index, payload) => {
      queries.push(payload.query);
      return { hits: { hits: spans.map(source => ({ _source: source, sort: [1, source.spanID] })) } };
    },
  };
  const code = await collectTrace({
    traceId: "t1", bizId: "message-1", spanId: options.span,
    traceIdResolution: { service: "fixture", resolvedAs: "message_id", sourceId: "source-message" },
    index: "jaeger-span-*", auth: {}, endpoint: "https://unused.test:9200", pageSize: 100, outputDir: dir,
    contributions: {
      measurementFilter: options.hiddenMeasurements ? () => false : undefined,
      agentRunExtractor: options.extracted ? { extract: trace => {
        options.extracted!();
        return createAgentRunIR(trace.trace_id, [{ id: "run-1", name: "fixture-agent", start_ms: 1000,
          duration_ms: 20, source_node_ids: ["root"], items: [{ kind: "agent-turn", id: "turn-1", name: "turn",
            start_ms: 1000, duration_ms: 20, items: [{ kind: "tool-call", id: "tool-1",
              name: "fixture-tool", start_ms: 1000, duration_ms: 20, source_node_ids: ["child"] }] }] }]);
      } } : undefined,
      specs: [{ kind: "fixture", structure_fields: ["payload"], matches: span => !options.grouped || span.name !== "child",
      claims: (_primary, candidates) => new Set(candidates.map(span => span.span_id)),
      value: (primary, satellites) => [primary, ...satellites].map(span => span.attr("payload")).join(" ") }] },
  }, () => {}, search);
  expect(code).toBe(options.partial ? 1 : 0);
  const destination = root();
  const artifact = { id: "trace", command: "trace", path: dir };
  await SerializeContext.create(destination, traceCommand, { status: options.partial ? CommandStatus.Partial : CommandStatus.Ok,
    output: { items: [{ bizId: "message-1", traceIds: ["t1"], status: options.partial ? CommandStatus.Partial : CommandStatus.Ok, artifacts: [artifact] }] }, artifacts: [artifact] });
  return { dir: destination, queries, spans };
}

async function offline(from: string, input: Partial<TraceInput> = {}) {
  let loads = 0;
  const context = new CommandContext({}, undefined, {
    environment: { kubeconfig: "/definitely-not-a-kubeconfig" },
    loadPlugin: async () => { loads++; throw new Error("offline must not load Plugin"); },
  });
  const result = await traceCommand.run(context, { bizIds: [], from, ...input });
  for (const artifact of result.artifacts) roots.push(artifact.path);
  expect(loads).toBe(0);
  expect(context.inspection.kubernetes).toBeUndefined();
  await context.disposeClients();
  if (result.artifacts.length) {
    const saved = await SerializeContext.create(root(), traceCommand, result);
    return { result: { ...result, artifacts: saved.artifacts }, context };
  }
  return { result, context };
}

test("online span uses trace AND span filters for count and download, and declares limited scope", async () => {
  const { dir, queries } = await fixture({ span: "s1" });
  expect(queries).toEqual(Array(2).fill({ bool: { filter: [{ term: { traceID: "t1" } }, { term: { spanID: "s1" } }] } }));
  expect(json(dir, "collection.json").target).toMatchObject({ input_id: "message-1", trace_id: "t1", span_id: "s1", scope: "span" });
  expect(readTraceSnapshot(dir).collection).toEqual({ scope: "span", span_id: "s1", complete: true });
  expect(json(dir, "findings.json")).toEqual({});
  const tree = json(dir, "tree.json");
  expect(tree.nodes.flatMap((node: { span_ids: string[] }) => node.span_ids)).toEqual(["s1"]);
  expect(existsSync(join(dir, "trace.html"))).toBeFalse();
});

test("full trace persists a forest and node-to-span mapping, node/span drilldown never loads environment or Plugin", async () => {
  const { dir } = await fixture();
  const tree = json(dir, "tree.json");
  expect(tree.roots).toHaveLength(2);
  expect(tree.nodes.find((node: { node_id: string }) => node.node_id === "child").value).toBe("input/output:child");
  expect(readTraceSnapshot(dir).nodes.find(node => node.node_id === "child")?.value).toBe("input/output:child");
  const node = tree.nodes.find((node: { primary_span_id: string }) => node.primary_span_id === "child");
  const original = readFileSync(join(dir, "manifest.json"), "utf8");
  for (const selected of [{ node: node.node_id }, { span: "child" }]) {
    const { result } = await offline(join(dir, "manifest.json"), selected);
    expect(result.status).toBe(CommandStatus.Ok);
    const path = result.artifacts[0]!.path;
    const detail = json(path, "selection.json");
    expect(detail.trace_id).toBe("t1");
    expect(detail.spans).toHaveLength(1);
    expect(detail.spans[0].attrs.payload).toBe("input/output:child");
    expect(detail.spans[0].raw.spanID).toBe("child");
    expect(json(path, "manifest.json").files.selection.path).toBe("selection.json");
    expect(json(path, "collection.json").source.mode).toBe("offline");
    const copied = await offline(join(path, "manifest.json"));
    expect(json(copied.result.artifacts[0]!.path, "collection.json").target).toEqual(json(path, "collection.json").target);
  }
  expect(readFileSync(join(dir, "manifest.json"), "utf8")).toBe(original);
  expect(existsSync(join(dir, "selection.json"))).toBeFalse();
});

test("delivered manifest indexes tree/details, survives relocation, and can be rendered offline", async () => {
  const { dir } = await fixture();
  const context = new CommandContext({});
  context.artifacts.add({ command: "trace", path: dir });
  const output = join(root(), "delivery");
  let stdout = "";
  const write = spyOn(process.stdout, "write").mockImplementation(chunk => { stdout += String(chunk); return true; });
  try {
    expect(await finalizeResult(context, traceCommand, { status: CommandStatus.Ok, output: undefined, artifacts: context.artifacts.list() }, { format: "manifest", output })).toBe(0);
  } finally { write.mockRestore(); }
  const delivered = JSON.parse(stdout);
  expect(existsSync(join(output, delivered.files.tree.path))).toBeTrue();
  expect(existsSync(join(output, delivered.files.analysis.path))).toBeTrue();
  const moved = root();
  cpSync(output, moved, { recursive: true });
  // The embedded absolute bundle_root deliberately still points to the original location.
  const { result } = await offline(join(moved, "manifest.json"));
  expect(result.status).toBe(CommandStatus.Ok);
  const render = new RenderContext(result.artifacts, "offline");
  await render.render(traceCommand, result);
  expect(render.failures).toHaveLength(0);
  expect(readFileSync(join(result.artifacts[0]!.path, "trace.html"), "utf8")).toContain("trace-archive");
  expect(readFileSync(join(result.artifacts[0]!.path, "trace.html"), "utf8")).toContain('id="node-search"');
  expect(readTraceSnapshot(result.artifacts[0]!.path).nodes.find(node => node.node_id === "child")?.value).toBe("input/output:child");
  expect(existsSync(join(moved, "trace.html"))).toBeFalse();
});

test("offline retains incomplete acquisition and truncation reasons instead of upgrading evidence to complete", async () => {
  const { dir } = await fixture({ partial: true });
  const source = json(dir, "collection.json");
  source.steps.push({ id: "limited", status: "partial", reason: "fixture limit", truncation: { reason: "raw_byte_limit", original_bytes: 100, limit_bytes: 10 } });
  writeFileSync(join(dir, "collection.json"), JSON.stringify(source));
  const { result } = await offline(join(dir, "manifest.json"), { span: "child" });
  expect(result.status).toBe(CommandStatus.Partial);
  expect(json(result.artifacts[0]!.path, "collection.json").steps).toEqual(source.steps);
  expect(json(result.artifacts[0]!.path, "selection.json").collection.complete).toBeFalse();
  expect(json(result.artifacts[0]!.path, "findings.json")).toEqual({});
});

test("missing local span/node fails without remote fallback, including span-only evidence", async () => {
  const { dir } = await fixture({ span: "only" });
  for (const selected of [{ span: "missing" }, { node: "missing" }]) {
    const { result } = await offline(join(dir, "manifest.json"), selected);
    expect(result.status).toBe(CommandStatus.Failed);
    if (result.status === CommandStatus.Failed) expect(result.reason).toContain("不会回连 OpenSearch");
  }
});

test("node selection collects all owned spans rather than treating node_id as span_id", async () => {
  const { dir } = await fixture({ grouped: true });
  const saved = readTraceSnapshot(dir);
  const node = saved.nodes.find(node => node.primary_span_id === "root")!;
  expect(node.span_ids).toEqual(["root", "child"]);
  expect(node.value).toBe("input/output:root input/output:child");
  const { result } = await offline(join(dir, "manifest.json"), { node: node.node_id });
  expect(result.status).toBe(CommandStatus.Ok);
  expect(json(result.artifacts[0]!.path, "selection.json").spans.map((span: { span_id: string }) => span.span_id)).toEqual(["root", "child"]);
});

test("manifest cannot escape its bundle through traversal or symlinks", async () => {
  const { dir } = await fixture();
  for (const relativePath of ["../outside/manifest.json", dir]) {
    const container = root();
    writeFileSync(join(container, "manifest.json"), JSON.stringify({ schemaVersion: 2, files: {},
      children: [{ command: "trace", manifest: relativePath }] }));
    expect((await offline(join(container, "manifest.json"))).result.status).toBe(CommandStatus.Failed);
  }
  symlinkSync(join(dir, "spans.jsonl"), join(dir, "unsafe-link"));
  expect((await offline(join(dir, "manifest.json"))).result.status).toBe(CommandStatus.Failed);
});

test("ambiguous local span requires a per-trace artifact manifest", async () => {
  const { dir } = await fixture();
  const container = root();
  cpSync(dir, join(container, "a"), { recursive: true });
  cpSync(dir, join(container, "b"), { recursive: true });
  writeFileSync(join(container, "manifest.json"), JSON.stringify({ schemaVersion: 2, files: {}, execution: { status: "ok" },
    children: ["a", "b"].map(path => ({ command: "trace", manifest: `${path}/manifest.json` })) }));
  const { result } = await offline(join(container, "manifest.json"), { span: "child" });
  expect(result.status).toBe(CommandStatus.Failed);
  if (result.status === CommandStatus.Failed) expect(result.reason).toContain("歧义");
});

test("invalid mode combinations are rejected before loading Plugin or Kubernetes", async () => {
  for (const input of [
    { from: undefined, node: "n", bizIds: ["id"] }, { from: "manifest", node: "n", span: "s" },
    { from: "manifest", bizIds: ["id"] }, { from: "manifest", endpoint: "https://unused.test" },
    { span: "  " }, { from: "" },
    { view: "measurements" }, { view: "timeline" }, { node: "child", view: "agent" }, { span: "child", view: "agent" },
  ] satisfies Partial<TraceInput>[]) expect((await offline("unused", input)).result.status).toBe(CommandStatus.Failed);
});

for (const format of ["manifest", "html", "bundle", "text", "json"]) test(`CLI offline ${format} uses root delivery without a Plugin or kubeconfig`, async () => {
  const { dir } = await fixture();
  const cwd = root();
  const output = join(cwd, format === "manifest" ? "delivery" : format === "bundle" ? "report.tar.gz" : `report.${format === "text" ? "txt" : format}`);
  const child = Bun.spawn({
    cmd: [process.execPath, "run", new URL("../src/app/entry.ts", import.meta.url).pathname,
      "trace", "--from", join(dir, "manifest.json"), "--format", format, "--output", output,
      "--config", join(cwd, "absent-config.yaml"), "--kubeconfig", join(cwd, "absent-kubeconfig"),
      "--namespace", "unused-offline-namespace"],
    cwd, env: { ...process.env, NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, ...(code ? { stderr } : {}) }).toEqual({ code: 0 });
  expect(existsSync(output)).toBeTrue();
  if (format === "manifest") {
    const result = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
    expect(stdout).toEndWith(`${JSON.stringify(result, null, 2)}\n`);
    expect(result.execution.status).toBe("ok");
    expect(result.files.tree).toBeDefined();
  } else if (format === "text") {
    expect(readFileSync(output, "utf8")).toContain("trace=t1 trace view=default");
    expect(readFileSync(output, "utf8")).toContain("scope=trace · complete=true");
  } else if (format === "json") {
    const exported = JSON.parse(readFileSync(output, "utf8"));
    expect(existsSync(exported.manifest)).toBeTrue();
    expect(exported.result.items[0].traces[0].view.rows.items).toHaveLength(3);
  } else if (format === "bundle") {
    const files = Bun.spawnSync({ cmd: ["tar", "-tzf", output], stdout: "pipe" });
    expect(files.exitCode).toBe(0);
    expect(files.stdout.toString()).toContain("spans.jsonl");
    expect(files.stdout.toString()).toContain("analysis.json");
  }
  expect(existsSync(join(dir, "manifest.json"))).toBeTrue();
  expect(existsSync(join(dir, "trace.html"))).toBeFalse();
}, 15000);


test("offline node views prepare hidden timing from saved measurements without changing source", async () => {
  const { dir } = await fixture({ hiddenMeasurements: true });
  const original = readFileSync(join(dir, "analysis.json"), "utf8");
  expect(readTraceSnapshot(dir).views.default.timings).toEqual({});
  for (const view of ["default", "measurements", "timeline"] as const) {
    const { result } = await offline(dir, { node: "child", view });
    expect(result.status).toBe(CommandStatus.Ok);
    const path = result.artifacts[0]!.path;
    const selected = json(path, "view.json");
    expect(selected).toMatchObject({ scope: "node", view, node: { node_id: "child" } });
    if (view === "default") expect(selected.spans.child.attrs.payload.value).toBe("input/output:child");
    else {
      expect(selected.timing).toMatchObject({ status: "measured", window: { elapsed_ms: 20 } });
      if (view === "timeline") expect(selected.calls.items.map((call: {node_id: string}) => call.node_id).sort())
        .toEqual(["another-root", "child", "root"]);
      else expect(selected.groups.items.reduce((sum: number, group: {total: number}) => sum + group.total, 0)).toBe(60);
    }
    const render = new RenderContext(result.artifacts, "offline");
    await render.render(traceCommand, result);
    expect(render.failures).toEqual([]);
    expect(readFileSync(join(path, "trace.html"), "utf8")).toContain(`child · ${view}`);
  }
  expect(readFileSync(join(dir, "analysis.json"), "utf8")).toBe(original);
});

test("incomplete or span-only evidence does not invent prefix timing", async () => {
  for (const options of [{ partial: true }, { span: "child" }]) {
    const { dir } = await fixture(options);
    const { result } = await offline(dir, { node: "child", view: "timeline" });
    const selected = json(result.artifacts[0]!.path, "view.json");
    expect(selected.timing).toBeNull();
    expect(selected.calls).toBeNull();
  }
});

test("Agent view reuses acquisition-time extraction in HTML and text", async () => {
  let extractions = 0;
  const { dir } = await fixture({ extracted: () => { extractions++; } });
  expect(extractions).toBe(1);
  const { result } = await offline(dir, { view: "agent" });
  const path = result.artifacts[0]!.path;
  expect(json(path, "view.json")).toMatchObject({ scope: "trace", view: "agent", status: "available" });
  expect(readFileSync(join(path, "view.txt"), "utf8")).toContain("fixture-tool");
  expect(json(path, "view.json").rows.items.some((row: {name: string}) => row.name === "another-root")).toBeFalse();
  const defaultResult = (await offline(dir)).result;
  const render = new RenderContext(defaultResult.artifacts, "offline");
  const report = await render.render(traceCommand, defaultResult);
  expect(render.failures).toEqual([]);
  expect(report.sections[0]!.pages).toHaveLength(2);
  expect(readFileSync(join(defaultResult.artifacts[0]!.path, "agent.html"), "utf8")).toContain("trace-archive");
  expect(extractions).toBe(1);
});

test("Agent projection without an extractor is explicitly unavailable", async () => {
  const { dir } = await fixture();
  const { result } = await offline(dir, { view: "agent" });
  expect(json(result.artifacts[0]!.path, "view.json")).toMatchObject({ view: "agent", status: "not_available" });
});

test("text delivery writes view to stdout with acquisition completeness", async () => {
  const { dir } = await fixture();
  const { result, context } = await offline(dir, { node: "child", view: "timeline" });
  let stdout = "";
  const write = spyOn(process.stdout, "write").mockImplementation(chunk => { stdout += String(chunk); return true; });
  try { expect(await finalizeResult(context, traceCommand, result, { format: "text" })).toBe(0); }
  finally { write.mockRestore(); }
  expect(stdout).toContain("node view=timeline");
  expect(stdout).toContain("complete=true");
  expect(stdout).toContain("Timeline:");
  expect(stdout).not.toContain("[delivery]");
});
