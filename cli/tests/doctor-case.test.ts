import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctorCaseCatalog, selectDoctorCases } from "../src/case/catalog";
import { httpScenarioFromDoctorCases } from "../src/case/http";

test("shared catalog filters one canonical CaseSet by command and selects multiple IDs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "doctor-case-catalog-"));
  try {
    writeFileSync(join(directory, "doctor-case.yaml"), `caseset: shared\nschema_version: 1\nfacets:\n  command: {values: [http, model, perf]}\ncases:\n  - id: ping\n    input: {method: GET, path: /ping, expect: {status: 200}}\n    facets: {command: http}\n  - id: health\n    input: {method: GET, path: /health, expect: {status: 204}}\n    facets: {command: http}\n  - id: chat\n    input: {path: /chat/completions, body: {messages: [{role: user, content: hello}]}}\n    facets: {command: model}\n  - id: load\n    input: {query: hello}\n    facets: {command: perf}\n`);
    const catalog = doctorCaseCatalog(undefined, undefined, directory);
    const http = await selectDoctorCases({ catalog, command: "http", caseSetId: "shared", caseIds: "health,ping" });
    expect(http?.cases.map((item) => item.id)).toEqual(["health", "ping"]);
    expect((await selectDoctorCases({ catalog, command: "model", caseSetId: "shared", caseIds: "chat" }))?.cases).toHaveLength(1);
    expect((await selectDoctorCases({ catalog, command: "perf", caseSetId: "shared", caseIds: "load" }))?.cases).toHaveLength(1);
    expect(() => httpScenarioFromDoctorCases(http!, "http://127.0.0.1:8765")).not.toThrow();
    const scenario = httpScenarioFromDoctorCases(http!, "http://127.0.0.1:8765");
    expect(scenario.requests.map((item) => item.id)).toEqual(["health", "ping"]);
    expect(scenario.requests[0]!.entrypoints[0]!.url).toBe("http://127.0.0.1:8765/health");
    expect(scenario.requests[0]!.entrypoints[0]!.expect.status).toEqual([204]);
    expect(() => httpScenarioFromDoctorCases(http!, "http://user:password@127.0.0.1:8765")).toThrow("无凭据");
    expect(() => httpScenarioFromDoctorCases({ ...http!, cases: [{ id: "target", input: { url: "http://other.test" } }] }, "http://127.0.0.1:8765")).toThrow("不能声明目标");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("external Case requires a command facet", () => {
  const directory = mkdtempSync(join(tmpdir(), "doctor-case-invalid-"));
  try {
    writeFileSync(join(directory, "doctor-case.yaml"), "caseset: missing_command\ncases:\n  - id: ping\n    input: {path: /ping}\n");
    expect(() => doctorCaseCatalog(undefined, undefined, directory)).toThrow("facets.command");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
