import { Operation } from "@compforge/harness-common";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { conceptToMarkdown, createServiceCatalog, type Knowledge } from "@compforge/doctor-plugin";
import { createCollectCommand, type CollectInput } from "../src/collect/composite";
import { CommandContext, CommandStatus } from "../src/command";
import { finalizeResult } from "./report-fixture";

test("delivered Service pages address source records, gaps, shared traces and pinned Knowledge", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-service-navigation-"));
  const knowledge: Knowledge = { markdown: () => "", concepts: [
    { id: "job", name: "Job", description: "A Job owns attempts.", markdown() { return conceptToMarkdown(this); } },
  ] };
  const component = { name: "example", repository: { forge: { name: "example" }, path: "example" } };
  const saveJob = new Operation({ serviceName: "worker", name: "save" });
  const lookup = new Operation({ serviceName: "unused", name: "lookup" });
  const validate = new Operation({ serviceName: "api", name: "validate", calls: [saveJob.id()] });
  const submit = new Operation({ serviceName: "api", name: "submit", calls: [validate.id(), saveJob.id()], mayCalls: [lookup.id()] });
  const plugin = { id: "demo", version: "2.1.0", knowledge, services: createServiceCatalog([
    { name: "api", description: "Handles requests", aliases: ["api-span"], knowledge, workloads: [], component, operations: [submit, validate] },
    { name: "worker", workloads: [], component, operations: [saveJob] },
    { name: "unused", workloads: [], component, operations: [lookup] },
  ]) };
  const context = new CommandContext({}, undefined, { plugin });
  const input: CollectInput = { kinds: ["data", "trace", "log"], bizIds: ["request-a", "request-b"] };
  const command = createCollectCommand(async kind => {
    const path = join(root, kind);
    mkdirSync(path);
    const save = (name: string, data: unknown) => writeFileSync(join(path, name), JSON.stringify(data));
    if (kind === "data") {
      save("collection.json", { files: { facts: "facts.json" } });
      save("facts.json", { capabilityResults: [
        { service: "api", status: "collected", id: "query-a", identity: { kind: "request", value: "request-a" },
          result: { facts: [{ factType: "record", kind: "attempt", recordKey: "attempt-A" }] } },
        { service: "worker", status: "failed", id: "query-b", identity: { kind: "request", value: "request-b" }, reason: "read timed out" },
      ] });
    } else if (kind === "trace") {
      save("collection.json", { target: { trace_id: "trace-a", input_id: "request-a" }, files: { tree: "tree.json", spans: "spans.jsonl" } });
      save("tree.json", { trace_id: "trace-a", collection: { complete: true }, nodes: [
        { service: "api-span", primary_span_id: "span-api" }, { service: "worker", primary_span_id: "span-worker" },
        { service: "undeclared", primary_span_id: "external-span" },
      ] });
      writeFileSync(join(path, "spans.jsonl"), '{"traceID":"trace-a"}\n');
    } else {
      save("collection.json", { target: { biz_id: "request-b" }, steps: [
        { id: "capture", service: "worker", title: "pod-2/container logs", status: "partial", reason: "time limit", raw_file: "capture.log" },
      ] });
      writeFileSync(join(path, "capture.log"), "captured event\n");
    }
    return { status: kind === "trace" ? CommandStatus.Ok : CommandStatus.Partial, output: undefined, artifacts: [context.artifacts.add({ command: kind, path })] };
  });
  try {
    const result = await command.run(context, input);
    const archive = join(root, "case.tar.gz");
    expect(await finalizeResult(context, command, result, { format: "bundle", output: archive }, input)).toBe(0);
    expect(Bun.spawnSync(["tar", "-xzf", archive, "-C", root]).exitCode).toBe(0);
    const read = (path: string) => readFileSync(join(root, "case", path), "utf8");
    const index = JSON.parse(read("manifest.json"));
    const summary = read("summary.md");
    expect(summary.indexOf("## Service")).toBeLessThan(summary.indexOf("## 采集命令"));
    expect(summary).toContain("services/api/summary.md");
    expect(summary).toContain("Handles requests");
    expect(summary).not.toContain("services/unused");
    expect(summary).not.toContain("services/undeclared");
    expect(index.files["services/worker/summary.md"]).toBeDefined();
    const worker = read("services/worker/summary.md"), api = read("services/api/summary.md");
    expect(api).toContain("capabilityResults.0.result.facts.0");
    expect(api).toContain("attempt-A");
    expect(api.split("\n").filter(line => line.includes("下游（calls）"))).toEqual(["- 下游（calls）：[worker](<../worker/summary.md>)"]);
    expect(api).toContain("下游（mayCalls）：unused");
    expect(worker).toContain("上游（calls）：[api](<../api/summary.md>)");
    const declarations = read("knowledge/operations.md");
    expect(declarations).toContain("operation:api/submit\n  - calls → operation:api/validate、operation:worker/save\n  - mayCalls → operation:unused/lookup");
    expect(declarations).toContain("## unused");
    expect(summary).toContain("[Operation 调用声明](<knowledge/operations.md>)");
    expect(worker).toContain("request-b");
    expect(worker).toContain("采集缺口");
    expect(worker).toContain("read timed out");
    expect(worker).toContain("capture.log");
    const traceLink = (page: string) => page.match(/\[原文\]\(<([^>]+spans\.jsonl)>\)/)?.[1];
    expect(api).toContain("span-api");
    expect(worker).toContain("span-worker");
    expect(traceLink(api)).toBeDefined();
    expect(traceLink(api)).toEqual(traceLink(worker));
    for (const [service, body] of [["api", api], ["worker", worker]] as const) {
      for (const match of body.matchAll(/\]\(<([^>]+)>\)/g)) {
        const [file, anchor] = match[1]!.split("#");
        const destination = read(posix.join("services", service, file!));
        expect(destination.length).toBeGreaterThan(0);
        if (anchor) expect(destination).toContain(`id="${anchor}"`);
      }
    }
    expect(read("services/api/knowledge.md")).toContain("demo@2.1.0");
    expect(read("knowledge/product.md")).toContain("A Job owns attempts");
    expect(read("AGENTS.md")).toContain("按 Service 职责选择服务页");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
