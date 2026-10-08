import { expect, test } from "bun:test";
import { validateCaseBindings, validateHttpCasesResult, type ProvidedHttpCase } from "../src";

const item: ProvidedHttpCase = { id: "download", description: "File", request: { url: "https://files.test/object?signature=secret" }, expect: { status: [200] } };
test("runtime Cases retain signed URLs in memory but reject writes and invalid contracts before execution", () => {
  expect(() => validateHttpCasesResult({ cases: [item] }, 1)).not.toThrow();
  for (const request of [{ url: "file:///etc/passwd" }, { url: "https://user:secret@files.test" },
    { url: item.request.url, method: "POST" }, { url: item.request.url, headers: { Authorization: "secret\r\nInjected: yes" } }]) {
    expect(() => validateHttpCasesResult({ cases: [{ ...item, request } as ProvidedHttpCase] }, 1)).toThrow();
  }
  expect(() => validateHttpCasesResult({ cases: [item, item] }, 1)).toThrow("at most");
  expect(() => validateHttpCasesResult({ cases: [item, item] }, 2)).toThrow("Duplicate");
  expect(() => validateHttpCasesResult({ cases: [] }, 1)).toThrow("reason");
  expect(() => validateHttpCasesResult({ cases: [], reason: "No file in tenant" }, 1)).not.toThrow();
});

test("binding references exact provider identity and a consumer Workload", () => {
  const binding = { id: "download", workload: "main", provider: { namespace: "plugin/test/service/kb", extension: "files" } };
  expect(() => validateCaseBindings([binding])).not.toThrow();
  expect(() => validateCaseBindings([binding, binding])).toThrow("Duplicate");
});
