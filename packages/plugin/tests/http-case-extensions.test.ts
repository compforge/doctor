import { expect, test } from "bun:test";
import { validateCaseBindings, validateCaseConsumeResult, validateExtension, withSummary, type CaseConsumeExtension, validateCaseProduceResult, type CaseProduceResult, requireCaseProduceExtension } from "../src";

test("Case producers declare optional identity requirements before execution", () => {
  const extension = { id: "probe", kind: "case.produce", access: {},
    run: withSummary({ title: "Probe", fields: [] }, async () => ({ cases: [], reason: "fixture" })) };
  expect(() => requireCaseProduceExtension(extension)).not.toThrow();
  const declared = { ...extension, requestIdentity: { configured: () => ({}) } };
  expect(() => requireCaseProduceExtension(declared)).not.toThrow();
  for (const requestIdentity of [null, true, {}, { configured: "invalid" }]) {
    const invalid = { ...extension, requestIdentity };
    expect(() => requireCaseProduceExtension(invalid)).toThrow("requestIdentity");
  }
});

const item: CaseProduceResult["cases"][number] = { case: { id: "download", desc: "File", input: { protocol: "http", method: "GET" },
  judge: { e2e: { http: { status: [200] } } } }, targets: [{ id: "primary", url: "https://files.test/object?signature=secret" }] };
test("runtime Cases retain signed URLs in memory and reject invalid contracts before execution", () => {
  expect(() => validateCaseProduceResult({ cases: [item] }, 1)).not.toThrow();
  for (const target of [{ url: "file:///etc/passwd" }, { url: "https://user:secret@files.test" },
    { url: item.targets[0]!.url, headers: { Authorization: "secret\r\nInjected: yes" } }]) {
    expect(() => validateCaseProduceResult({ cases: [{ ...item, targets: [{ id: "primary", ...target }] }] }, 1)).toThrow();
  }
  expect(() => validateCaseProduceResult({ cases: [{ ...item, case: { ...item.case, input: { protocol: "http", method: "POST" } } }] }, 1)).not.toThrow();
  expect(() => validateCaseProduceResult({ cases: [{ ...item, case: { ...item.case, judge: {} } }] }, 1)).toThrow("criteria");
  expect(() => validateCaseProduceResult({ cases: [item, item] }, 1)).toThrow("at most");
  expect(() => validateCaseProduceResult({ cases: [item, item] }, 2)).toThrow("Duplicate");
  expect(() => validateCaseProduceResult({ cases: [] }, 1)).toThrow("reason");
  expect(() => validateCaseProduceResult({ cases: [], reason: "No file in tenant" }, 1)).not.toThrow();
});

test("binding references exact provider identity and a consumer Workload", () => {
  const binding = { id: "download", workload: "main", producer: { namespace: "plugin/test/service/kb", extension: "files" } };
  expect(() => validateCaseBindings([binding])).not.toThrow();
  expect(() => validateCaseBindings([binding, binding])).toThrow("Duplicate");
});

test("case.consume is an ordinary executable Extension returning relationship data", async () => {
  const extension: CaseConsumeExtension = { id: "downloads", kind: "case.consume", access: {},
    run: withSummary({ title: "Downloads", fields: [] }, async (_context, query) => ({ bindings: query.tenantId ? [{
      id: "file", workload: "main", producer: { namespace: "plugin/test/service/files", extension: "downloads" },
    }] : [] })) };
  expect(() => validateExtension(extension)).not.toThrow();
  expect(() => validateExtension({ ...extension, run: undefined })).toThrow("run");
  expect(() => validateCaseConsumeResult({ bindings: [] })).not.toThrow();
  expect(() => validateCaseConsumeResult({} as never)).toThrow("array");
});

test("produced Cases explicitly select a supported protocol independently of the URL scheme", () => {
  for (const protocol of [undefined, "https", "tcp"]) {
    expect(() => validateCaseProduceResult({ cases: [{ ...item, case: { ...item.case, input: { ...item.case.input, protocol } } } as never] }, 1)).toThrow("protocol");
  }
  for (const scheme of ["http", "https"]) {
    expect(() => validateCaseProduceResult({ cases: [{ ...item, targets: [{ id: "primary", url: `${scheme}://files.test/object` }] }] }, 1)).not.toThrow();
  }
});


test("runtime routes are bounded, nonempty and uniquely named before any request", () => {
  for (const targets of [[], [item.targets[0]!, item.targets[0]!], Array.from({ length: 6 }, (_, i) => ({ id: String(i), url: "https://files.test" }))]) {
    expect(() => validateCaseProduceResult({ cases: [{ ...item, targets }] }, 1)).toThrow();
  }
  for (const path of ["//other.test", "/\t/other.test", "/\\other.test"]) {
    expect(() => validateCaseProduceResult({ cases: [{ ...item, case: { ...item.case, input: { ...item.case.input, path } } }] }, 1)).toThrow("origin-relative");
  }
});

test("runtime bodies are limited to non-read requests and cannot introduce automatic write replay", () => {
  const post = { ...item, case: { ...item.case, input: { protocol: "http" as const, method: "POST" as const, body: "hello" } },
    targets: [{ ...item.targets[0]!, body: "runtime" }] };
  expect(() => validateCaseProduceResult({ cases: [post] }, 1)).not.toThrow();
  expect(() => validateCaseProduceResult({ cases: [{ ...post, targets: [...post.targets, { id: "retry", url: "http://alternate.test" }] }] }, 1)).toThrow("replay");
  expect(() => validateCaseProduceResult({ cases: [{ ...item, targets: post.targets }] }, 1)).toThrow("non-read");
  expect(() => validateCaseProduceResult({ cases: [{ ...post, targets: [{ ...post.targets[0]!, body: {} as never }] }] }, 1)).toThrow("string body");
});

test("SSE expectations are validated before execution", () => {
  for (const sse of [{}, { eventField: "type", terminalEvent: "END", errorEvents: [], requiredEvents: ["MESSAGE"] },
    { eventField: "type", terminalEvent: "END", errorEvents: ["ERROR"], requiredEvents: ["MESSAGE"], unexpected: true }]) {
    expect(() => validateCaseProduceResult({ cases: [{ ...item, case: { ...item.case, judge: { e2e: {
      http: { status: [200], contentType: "text/event-stream" }, sse,
    } } } }] }, 1)).toThrow();
  }
});
