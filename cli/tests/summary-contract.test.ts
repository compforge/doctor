import { afterEach, expect, test, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withSummary, validateExtensionResult, type Summary } from "@compforge/doctor-plugin";
import { projectSummary } from "../src/command/summary";
import { SerializeContext } from "../src/command/serialization/context";
import { CommandStatus } from "../src/command/status";
import { deliverSerialized } from "../src/app/delivery";
import { createHostPluginContext } from "../src/plugin/context";

const roots: string[] = [];
const temporary = () => { const root = mkdtempSync(join(tmpdir(), "doctor-summary-contract-")); roots.push(root); return root; };
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const summary: Summary = { title: "状态", fields: ["ok", "count", "empty", "missing", "body", "long", "array", "secret"].map(label => ({ label, path: [label] })) };

test("summary preserves false, zero and null, bounds collections and never expands bodies or getters", () => {
  const data = { ok: false, count: 0, empty: null, body: { huge: "x".repeat(1_000_000) }, long: "y".repeat(100_000), array: Array(1000).fill(1),
    get secret() { throw new Error("must not materialize a resource"); } };
  const result = projectSummary(summary, data);
  expect(result.fields.slice(0, 3).map(field => field.value)).toEqual(["false", "0", "null"]);
  expect(result.fields.some(field => ["missing", "secret"].includes(field.label))).toBe(false);
  expect(JSON.stringify(result).length).toBeLessThan(1500);
  expect(JSON.stringify(result)).not.toContain("xxx");
  expect(projectSummary({ title: "Many", fields: Array(1000).fill({ label: "Count", path: ["count"] }) }, data).omitted).toBe(988);
});

test("summary validation does not read or consume Extension data", async () => {
  const context = createHostPluginContext({ service: { name: "fixture", component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixture" } }, workloads: [] }, capability: { access: {} } });
  const body = new ReadableStream<Uint8Array>();
  const runner = { run: () => { throw new Error("not invoked"); } };
  try {
    const run = withSummary({ title: "Response", fields: [{ label: "HTTP", path: ["statusCode"] }] }, async () => ({ statusCode: 200, body, runner }));
    const result = await run(context, undefined);
    validateExtensionResult(result);
    expect(result.data.body).toBe(body);
    expect(result.data.runner).toBe(runner);
    expect(body.locked).toBe(false);
    expect(() => validateExtensionResult({ data: null })).toThrow("Summary");
    expect(() => validateExtensionResult({ data: null, summary: { title: "Empty", fields: [] } })).not.toThrow();
  } finally { await context.dispose(); }
});

test("Command Summary, on-disk summary and format summary share one projection; manifest stdout equals disk", async () => {
  const root = temporary();
  await SerializeContext.create(root, { name: "doctor fixture" }, {
    status: CommandStatus.Ok, artifacts: [], summary, output: { ok: false, count: 0, empty: null },
  });
  expect(JSON.parse(readFileSync(join(root, "summary.json"), "utf8")).summary).toEqual(summary);
  const output = spyOn(process.stdout, "write").mockImplementation(() => true);
  const errors = spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    expect(await deliverSerialized({ directory: root, options: { format: "summary" }, code: 0, reportName: "test" })).toBe(true);
    expect(output).toHaveBeenCalledWith(readFileSync(join(root, "summary.md"), "utf8"));
    output.mockClear();
    expect(await deliverSerialized({ directory: root, options: { format: "manifest" }, code: 0, reportName: "test" })).toBe(true);
    const printed = output.mock.calls.map(([text]) => String(text)).join("");
    const stored = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
    expect(JSON.parse(printed)).toEqual(stored);
    expect(stored).toMatchObject({ schemaVersion: 2, kind: "command", title: "状态", execution: { status: "ok" }, delivery: { status: "ok" } });
    expect(stored).not.toHaveProperty("output");
  } finally { output.mockRestore(); errors.mockRestore(); }
});

test("invalid Summary records a serialization failure while preserving raw output", async () => {
  const root = temporary();
  const context = await SerializeContext.create(root, { name: "doctor invalid" }, {
    status: CommandStatus.Ok, artifacts: [], output: { value: 1 }, summary: { title: "", fields: [] },
  });
  expect(context.failed).toBe(true);
  expect(JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")).serialization.status).toBe("failed");
  expect(JSON.parse(readFileSync(join(root, "output.json"), "utf8"))).toEqual({ value: 1 });
});
