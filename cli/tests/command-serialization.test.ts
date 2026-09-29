import { traceCommand } from "../src/collect/trace/command";
import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CommandContext, CommandStatus, defineCommand, type CommandResult } from "../src/command";
import { SerializeContext } from "../src/command/serialization/context";
import type { Manifest } from "../src/command/manifest";
import { EvidenceBundle } from "../src/collect/evidence";
import { serializeEvidenceResult } from "../src/collect/serialize";
import { serializeData } from "../src/collect/data/serialize";
import type { DataOutput } from "../src/collect/data/model";
import { finalizeCommand } from "../src/app/finalize";
import { RenderContext } from "../src/report/context";

const roots: string[] = [];
const temporary = () => { const root = mkdtempSync(join(tmpdir(), "doctor-serialize-test-")); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const ok = <T>(output: T): CommandResult<T> => ({ status: CommandStatus.Ok, output, artifacts: [] });

test("nested aggregates retain direct edges, reuse the same result and remain portable", async () => {
  let calls = 0;
  const leaf = defineCommand({ name: "doctor data", prepare: async (_context, input) => input, run: async () => ok({ value: "body" }),
    serialize: async (context, result) => {
      calls++;
      return { files: { facts: context.writeJson("raw/facts.json", result.output) } };
    } });
  const shared = ok({ value: "body" });
  const separate = ok({ value: "body" });
  const aggregate = defineCommand({ name: "doctor collect", prepare: async (_context, input) => input, run: async () => ok([shared]),
    serialize: async (context, result) => ({ files: {}, children: await Promise.all((result.output ?? []).map(child => context.serialize(leaf, child))) }) });
  const root = defineCommand({ name: "doctor overview", prepare: async (_context, input) => input, run: async () => ok([ok([shared]), ok([shared, separate])]),
    serialize: async (context, result) => ({ files: {}, children: await Promise.all((result.output ?? []).map(child => context.serialize(aggregate, child))) }) });
  const source = temporary();
  await SerializeContext.create(source, root, ok([ok([shared]), ok([shared, separate])]));
  expect(calls).toBe(2);
  const destination = join(temporary(), "moved");
  cpSync(source, destination, { recursive: true });
  rmSync(source, { recursive: true });
  const manifest = read(join(destination, "manifest.json")) as Manifest;
  expect(manifest.source.command).toBe("overview");
  expect(manifest.children).toHaveLength(2);
  expect(manifest.files.summary.path).toBe("summary.md");
  const summary = readFileSync(join(destination, manifest.files.summary.path), "utf8");
  expect(summary).toContain("## 证据导航");
  for (const child of manifest.children!) expect(summary).toContain(child.manifest);
  const parents = manifest.children!.map(child => {
    const path = join(destination, child.manifest);
    return { path, manifest: read(path) as Manifest };
  });
  expect(parents.map(parent => parent.manifest.source.command)).toEqual(["collect", "collect"]);
  const childIds = parents.flatMap(parent => parent.manifest.children!.map(child => child.id));
  expect(new Set(childIds).size).toBe(2);
  for (const parent of parents) for (const child of parent.manifest.children!) {
    const path = join(dirname(parent.path), child.manifest);
    const saved = read(path) as Manifest;
    expect(read(join(dirname(path), saved.files.facts!.path))).toEqual({ value: "body" });
  }
});

test("serialization failure keeps successful files and sibling results, and never publishes broken JSONL", async () => {
  const failed = defineCommand({ name: "doctor log", prepare: async (_context, input) => input, run: async () => ok(undefined),
    serialize: async context => {
      context.writeJson("raw/facts.json", { saved: true });
      await context.writeJsonl("raw/records.jsonl", [{ valid: true }, BigInt(1)]);
      return { files: {} };
    } });
  const good = defineCommand({ name: "doctor trace", prepare: async (_context, input) => input, run: async () => ok(undefined),
    serialize: async context => ({ files: { facts: context.writeJson("raw/facts.json", {}) } }) });
  const parent = defineCommand({ name: "doctor collect", prepare: async (_context, input) => input, run: async () => ok(undefined),
    serialize: async context => ({ files: {}, children: [await context.serialize(failed, ok(undefined)), await context.serialize(good, ok(undefined))] }) });
  const dir = temporary();
  const writer = await SerializeContext.create(dir, parent, ok(undefined));
  expect(writer.failed).toBe(true);
  const manifest = read(join(dir, "manifest.json"));
  const failure = join(dir, manifest.children[0].manifest);
  expect(read(failure).serialization.status).toBe("failed");
  expect(read(join(dirname(failure), "raw/facts.json"))).toEqual({ saved: true });
  expect(existsSync(join(dirname(failure), "raw/records.jsonl"))).toBe(false);
  expect(read(join(dir, manifest.children[1].manifest)).serialization.status).toBe("ok");
});

test("diagnosis body is externalized and render rehydrates it from relocated evidence", async () => {
  const source = temporary(), destination = temporary();
  const bundle = new EvidenceBundle(source);
  const facts = { text: "large-body-".repeat(100_000) };
  bundle.writeCollection({ doctorVersion: "test", target: {}, inspectionFacts: facts, params: {}, startedAt: "start", finishedAt: "end" });
  writeFileSync(join(source, "diagnosis.json"), JSON.stringify({ evidence: { facts, observations: [{ id: "one", value: 1 }] }, findings: [], coverage: [] }));
  const artifact = { id: "a", command: "inspect", path: source };
  const result = { ...ok(undefined), artifacts: [artifact] };
  const spec = defineCommand({ name: "doctor inspect", prepare: async (_context, input) => input, run: async () => result, serialize: serializeEvidenceResult });
  const saved = await SerializeContext.create(destination, spec, result);
  rmSync(source, { recursive: true });
  expect(readFileSync(join(destination, "diagnosis.json"), "utf8")).not.toContain("large-body");
  expect(readFileSync(join(destination, "manifest.json"), "utf8")).not.toContain("large-body");
  const renderer = new RenderContext(saved.artifacts, "test");
  expect(renderer.json<{ evidence: { facts: unknown } }>(artifact, "diagnosis.json").evidence.facts).toEqual(facts);
  expect(statSync(join(destination, "raw/facts.json")).mode & 0o777).toBe(0o600);
});

test("Data serializes multiple input selections without copying Facts into diagnoses", async () => {
  const source = temporary();
  const query = (id: string) => ({ id, stage: "provide", service: "sample", identity: { kind: "biz_id", value: id },
    kind: "data.inspect-result", schemaVersion: 1, producer: { origin: "core", id: "test" }, status: "unavailable", reason: "missing" });
  const facts = { services: {}, capabilityResults: [query("first"), query("second")] };
  new EvidenceBundle(source).writeCollection({ doctorVersion: "test", target: {}, inspectionFacts: facts, params: {}, startedAt: "start", finishedAt: "end" });
  const artifact = { id: "snapshot", command: "data", path: source };
  const items = facts.capabilityResults.map((query, index) => ({ bizId: query.id, status: CommandStatus.Partial, artifacts: [artifact],
    diagnosis: { evidence: { facts: { services: {}, capabilityResults: [query] }, observations: [] },
      findings: [{ id: `finding-${index}`, evidence: [{ factPath: "capabilityResults.0", role: "supporting" }] }], coverage: [] } }));
  const result = { ...ok({ items } as unknown as DataOutput), artifacts: [artifact] };
  const spec = defineCommand({ name: "doctor data", prepare: async (_context, input) => input, run: async () => result, serialize: serializeData });
  const dir = temporary();
  await SerializeContext.create(dir, spec, result);
  const manifest = read(join(dir, "manifest.json"));
  expect(manifest.children).toEqual([]);
  expect(manifest.files.facts.path).toBe("raw/facts.json");
  expect(existsSync(join(dir, "artifacts"))).toBe(false);
  const diagnosis = read(join(dir, "diagnosis.json"));
  expect(diagnosis.items[1].findings[0].evidence[0].factPath).toBe("capabilityResults.1");
  expect(diagnosis.items[1].selection.queryIds).toEqual(["second"]);
  expect(diagnosis.items[0]).not.toHaveProperty("evidence");
});

test("a missing staged source does not discard the other items of an execution", async () => {
  const source = temporary(), destination = temporary();
  writeFileSync(join(source, "raw.txt"), "retained evidence");
  const result = { ...ok(undefined), artifacts: [
    { id: "missing", command: "log", path: join(source, "missing") },
    { id: "available", command: "log", path: source },
  ] };
  const saved = await SerializeContext.create(destination, { name: "doctor log", serialize: serializeEvidenceResult }, result);
  expect(saved.failed).toBe(true);
  const manifest = read(join(destination, "manifest.json"));
  expect(manifest.serialization.status).toBe("failed");
  expect(readFileSync(join(destination, manifest.files["items/available/raw.txt"].path), "utf8")).toBe("retained evidence");
});

test("Finalize indexing records every local page with private permissions", async () => {
  const destination = temporary();
  const saved = await SerializeContext.create(destination, { name: "doctor data", serialize: async () => ({ files: {} }) }, ok(undefined));
  writeFileSync(join(destination, "data-1.html"), "one", { mode: 0o644 });
  writeFileSync(join(destination, "data-2.html"), "two", { mode: 0o644 });
  saved.indexReports();
  const manifest = read(join(destination, "manifest.json"));
  expect(Object.keys(manifest.files)).toEqual(["summary", "data-1.html", "data-2.html"]);
  for (const file of Object.values(manifest.files) as { path: string; bytes: number }[]) {
    expect(statSync(join(destination, file.path)).mode & 0o777).toBe(0o600);
    expect(statSync(join(destination, file.path)).size).toBe(file.bytes);
  }
});

test("HTML assembly failure still delivers serialized evidence in the Bundle", async () => {
  const source = temporary(), destination = temporary();
  writeFileSync(join(source, "raw.txt"), "retained after HTML failure");
  const context = new CommandContext({});
  const artifact = context.artifacts.add({ id: "source", command: "test", path: source });
  const result = { ...ok(undefined), artifacts: [artifact] };
  const spec = defineCommand({ name: "doctor test", prepare: async (_context, input) => input, run: async () => result, serialize: serializeEvidenceResult,
    render: async (renderer) => ({ title: "test", sections: [{ id: "test", title: "test", status: CommandStatus.Ok,
      pages: [renderer.page(artifact, { title: "Missing page", status: CommandStatus.Ok }, "absent.html")] }] }),
  });
  const archive = join(destination, "result.tar.gz");
  expect(await finalizeCommand({ commandInput: {}, spec, result, context, code: 0, delivery: { format: "bundle", output: archive } })).toBe(1);
  const readArchive = (file: string) => {
    const output = Bun.spawnSync(["tar", "-xOf", archive, `result/${file}`]);
    expect(output.exitCode).toBe(0);
    return output.stdout.toString();
  };
  const manifest = JSON.parse(readArchive("manifest.json"));
  expect(manifest.render.status).toBe("failed");
  expect(manifest.execution.status).toBe("ok");
  expect(manifest.delivery.exitCode).toBe(1);
  expect(readArchive(manifest.files["raw.txt"].path)).toBe("retained after HTML failure");
  expect(existsSync(source)).toBe(true);
});


test("multi-artifact summary locates trace evidence by its target and survives relocation", async () => {
  const source = temporary(), destination = temporary();
  new EvidenceBundle(source).writeCollection({ doctorVersion: "test", target: { trace_id: "trace-1", input_id: "conversation-1" },
    inspectionFacts: {}, params: {}, startedAt: "start", finishedAt: "end" });
  writeFileSync(join(source, "summary.md"), "# Trace trace-1\n");
  const result = { ...ok(undefined), artifacts: [
    { id: "resolve", command: "trace", path: source }, { id: "actual", command: "trace", path: source },
  ] };
  await SerializeContext.create(destination, traceCommand, { ...result, output: { items: [{ bizId: "conversation-1", traceIds: ["trace-1"], status: CommandStatus.Ok, artifacts: [result.artifacts[1]!] }] } });
  const moved = join(temporary(), "bundle");
  cpSync(destination, moved, { recursive: true });
  const manifest = read(join(moved, "manifest.json"));
  const summary = readFileSync(join(moved, manifest.files.summary.path), "utf8");
  expect(summary).toContain("ID 解析");
  expect(summary).toContain("Trace 详情");
  expect(summary).not.toContain("evidence · unknown");
  expect(summary).toContain("trace-1");
  expect(summary).toContain("conversation-1");
  expect(summary).toContain("items/actual/summary.md");
  for (const match of summary.matchAll(/\]\(<([^>]+)>\)/g)) expect(existsSync(join(moved, match[1]!))).toBe(true);
});
