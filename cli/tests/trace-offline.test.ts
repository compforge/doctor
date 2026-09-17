import { afterEach, expect, spyOn, test } from "bun:test";
import type { SearchEngine } from "@compforge/harness-toolbox/opensearch/types";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectTrace } from "../src/collect/trace";
import { traceCommand, type TraceInput } from "../src/collect/trace/command";
import { readTraceSnapshot } from "../src/collect/trace/snapshot";
import { CommandContext, CommandStatus } from "../src/command";
import { deliverManifest } from "../src/app/manifest-delivery";
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

async function fixture(options: { span?: string; partial?: boolean; grouped?: boolean } = {}) {
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
    contributions: { specs: [{ kind: "fixture", matches: span => !options.grouped || span.name !== "child",
      claims: (_primary, candidates) => new Set(candidates.map(span => span.span_id)) }] },
  }, () => {}, search);
  expect(code).toBe(options.partial ? 1 : 0);
  return { dir, queries, spans };
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
  return { result, context };
}

test("online span uses trace AND span filters for count and download, and declares limited scope", async () => {
  const { dir, queries } = await fixture({ span: "s1" });
  expect(queries).toEqual(Array(2).fill({ bool: { filter: [{ term: { traceID: "t1" } }, { term: { spanID: "s1" } }] } }));
  expect(json(dir, "manifest.json").target).toMatchObject({ input_id: "message-1", trace_id: "t1", span_id: "s1", scope: "span" });
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
    expect(json(path, "manifest.json").files.selection).toBe("selection.json");
    expect(json(path, "manifest.json").source.mode).toBe("offline");
    const copied = await offline(join(path, "manifest.json"));
    expect(json(copied.result.artifacts[0]!.path, "manifest.json").target).toEqual(json(path, "manifest.json").target);
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
    expect(deliverManifest({ command: "doctor trace", code: 0, result: { status: CommandStatus.Ok }, context, output }).delivered).toBeTrue();
  } finally { write.mockRestore(); }
  const delivered = JSON.parse(stdout);
  expect(existsSync(join(output, delivered.artifacts[0].files.tree))).toBeTrue();
  expect(existsSync(join(output, delivered.artifacts[0].files.analysis))).toBeTrue();
  const moved = root();
  cpSync(output, moved, { recursive: true });
  // The embedded absolute bundle_root deliberately still points to the original location.
  const { result } = await offline(join(moved, "manifest.json"));
  expect(result.status).toBe(CommandStatus.Ok);
  const render = new RenderContext(result.artifacts, "offline");
  await render.render(traceCommand, result);
  expect(render.failures).toHaveLength(0);
  expect(readFileSync(join(result.artifacts[0]!.path, "trace.html"), "utf8")).toContain("trace-archive");
  expect(existsSync(join(moved, delivered.artifacts[0].path, "trace.html"))).toBeFalse();
});

test("offline retains incomplete acquisition and truncation reasons instead of upgrading evidence to complete", async () => {
  const { dir } = await fixture({ partial: true });
  const source = json(dir, "manifest.json");
  source.steps.push({ id: "limited", status: "partial", reason: "fixture limit", truncation: { reason: "raw_byte_limit", original_bytes: 100, limit_bytes: 10 } });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(source));
  const { result } = await offline(join(dir, "manifest.json"), { span: "child" });
  expect(result.status).toBe(CommandStatus.Partial);
  expect(json(result.artifacts[0]!.path, "manifest.json").steps).toEqual(source.steps);
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
  const { result } = await offline(join(dir, "manifest.json"), { node: node.node_id });
  expect(result.status).toBe(CommandStatus.Ok);
  expect(json(result.artifacts[0]!.path, "selection.json").spans.map((span: { span_id: string }) => span.span_id)).toEqual(["root", "child"]);
});

test("manifest cannot escape its bundle through traversal or symlinks", async () => {
  const { dir } = await fixture();
  for (const relativePath of ["../outside/manifest.json", dir]) {
    const container = root();
    writeFileSync(join(container, "manifest.json"), JSON.stringify({ kind: "doctor.bundle", schema_version: 1,
      artifacts: [{ command: "trace", path: relativePath, manifest: relativePath }] }));
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
  writeFileSync(join(container, "manifest.json"), JSON.stringify({ kind: "doctor.bundle", schema_version: 1,
    artifacts: ["a", "b"].map(path => ({ command: "trace", path })) }));
  const { result } = await offline(join(container, "manifest.json"), { span: "child" });
  expect(result.status).toBe(CommandStatus.Failed);
  if (result.status === CommandStatus.Failed) expect(result.reason).toContain("歧义");
});

test("invalid mode combinations are rejected before loading Plugin or Kubernetes", async () => {
  for (const input of [
    { from: undefined, node: "n", bizIds: ["id"] }, { from: "manifest", node: "n", span: "s" },
    { from: "manifest", bizIds: ["id"] }, { from: "manifest", endpoint: "https://unused.test" },
    { span: "  " }, { from: "" },
  ]) expect((await offline("unused", input)).result.status).toBe(CommandStatus.Failed);
});

for (const format of ["manifest", "html", "bundle"]) test(`CLI offline ${format} uses root delivery without a Plugin or kubeconfig`, async () => {
  const { dir } = await fixture();
  const cwd = root();
  const output = join(cwd, format === "manifest" ? "delivery" : format === "html" ? "report.html" : "report.tar.gz");
  const child = Bun.spawn({
    cmd: [process.execPath, "run", new URL("../src/app/entry.ts", import.meta.url).pathname,
      "trace", "--from", join(dir, "manifest.json"), "--format", format, "--output", output,
      "--config", join(cwd, "absent-config.yaml"), "--kubeconfig", join(cwd, "absent-kubeconfig")],
    cwd, env: { ...process.env, NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, ...(code ? { stderr } : {}) }).toEqual({ code: 0 });
  expect(existsSync(output)).toBeTrue();
  if (format === "manifest") {
    const result = JSON.parse(stdout);
    expect(result.status).toBe("ok");
    expect(result.artifacts[0].files.tree).toBeDefined();
  } else if (format === "bundle") {
    const files = Bun.spawnSync({ cmd: ["tar", "-tzf", output], stdout: "pipe" });
    expect(files.exitCode).toBe(0);
    expect(files.stdout.toString()).toContain("spans.jsonl");
    expect(files.stdout.toString()).toContain("analysis.json");
  }
  expect(existsSync(join(dir, "manifest.json"))).toBeTrue();
  expect(existsSync(join(dir, "trace.html"))).toBeFalse();
}, 15000);
