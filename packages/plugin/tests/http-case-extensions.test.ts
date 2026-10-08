import { expect, test } from "bun:test";
import { validateCaseBindings, validateCaseConsumeResult, validateExtension, withSummary, type CaseConsumeExtension, validateCaseProduceResult, type ProducedHttpCase } from "../src";

const item: ProducedHttpCase = { id: "download", protocol: "http", description: "File", request: { url: "https://files.test/object?signature=secret" }, expect: { status: [200] } };
test("runtime Cases retain signed URLs in memory but reject writes and invalid contracts before execution", () => {
  expect(() => validateCaseProduceResult({ cases: [item] }, 1)).not.toThrow();
  for (const request of [{ url: "file:///etc/passwd" }, { url: "https://user:secret@files.test" },
    { url: item.request.url, method: "POST" }, { url: item.request.url, headers: { Authorization: "secret\r\nInjected: yes" } }]) {
    expect(() => validateCaseProduceResult({ cases: [{ ...item, request } as ProducedHttpCase] }, 1)).toThrow();
  }
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
    expect(() => validateCaseProduceResult({ cases: [{ ...item, protocol } as never] }, 1)).toThrow("protocol");
  }
  for (const scheme of ["http", "https"]) {
    expect(() => validateCaseProduceResult({ cases: [{ ...item, request: { url: `${scheme}://files.test/object` } }] }, 1)).not.toThrow();
  }
});
