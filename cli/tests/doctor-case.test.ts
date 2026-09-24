import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctorCaseCatalog, selectDoctorCases } from "../src/case/catalog";
import { httpScenarioFromDoctorCases } from "../src/case/http";
import { createDoctorExtensionRegistry } from "../src/plugin/extension-registry";
import { createServiceCatalog, withSummary, type CaseCatalogExtension, type PluginDefinition } from "@compforge/doctor-plugin";

test("shared catalog filters one canonical CaseSet by command and selects multiple IDs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "doctor-case-catalog-"));
  try {
    writeFileSync(join(directory, "doctor-cases.yaml"), `caseset: shared\nschema_version: 1\nfacets:\n  command: {values: [http, model, perf]}\ncases:\n  - id: ping\n    input: {method: GET, path: /ping, expect: {status: 200}}\n    facets: {command: http}\n  - id: health\n    input: {method: GET, path: /health, expect: {status: 204}}\n    facets: {command: http}\n  - id: chat\n    input: {path: /chat/completions, body: {messages: [{role: user, content: hello}]}}\n    facets: {command: model}\n  - id: load\n    input: {query: hello}\n    facets: {command: perf}\n  - id: load_more\n    input: {query: world}\n    facets: {command: perf}\n`);
    const catalog = doctorCaseCatalog(undefined, undefined, directory);
    const http = await selectDoctorCases({ catalog, command: "http", caseSetId: "shared", caseIds: "health,ping" });
    expect(http?.cases.map((item) => item.id)).toEqual(["health", "ping"]);
    expect((await selectDoctorCases({ catalog, command: "model", caseSetId: "shared", caseIds: "chat" }))?.cases).toHaveLength(1);
    expect((await selectDoctorCases({ catalog, command: "perf", caseSetId: "shared", caseIds: "load,load_more" }))?.cases.map((item) => item.id)).toEqual(["load", "load_more"]);
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
    writeFileSync(join(directory, "doctor-cases.yaml"), "caseset: missing_command\ncases:\n  - id: ping\n    input: {path: /ping}\n");
    expect(() => doctorCaseCatalog(undefined, undefined, directory)).toThrow("facets.command");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("catalog does not auto-load the old doctor-case.yaml filename", () => {
  const directory = mkdtempSync(join(tmpdir(), "doctor-old-case-name-"));
  try {
    writeFileSync(join(directory, "doctor-case.yaml"), "caseset: old_name\ncases: []\n");
    expect(doctorCaseCatalog(undefined, undefined, directory).map((item) => item.caseSet.caseset))
      .toEqual(["doctor_model", "doctor_http"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Core and Plugin catalog extensions share discovery; command filtering uses only facets", async () => {
  const directory = mkdtempSync(join(tmpdir(), "doctor-case-extensions-"));
  try {
    writeFileSync(join(directory, "doctor-cases.yaml"), `caseset: local_cases\nfacets:\n  command: {values: [http, "eval,perf"]}\ncases:\n  - id: local_ping\n    input: {path: /ping}\n    facets: {command: http}\n  - id: local_chat\n    input: {query: hello}\n    facets: {command: "eval,perf"}\n`);
    const pluginCases: CaseCatalogExtension = { id: "fixture.cases", kind: "case.catalog", load: () => [{
      caseset: "plugin_cases", facets: { command: { values: ["perf"] } }, cases: [
        { id: "probe", input: { query: "hello" }, facets: { command: "perf" } },
        { id: "unassigned", input: { query: "ignored" } },
      ],
    }] };
    const plugin: PluginDefinition = {
      id: "fixture", version: "1", services: createServiceCatalog([]),
      extensions: [pluginCases],
    };
    const catalog = doctorCaseCatalog(plugin, undefined, directory);
    expect(catalog.map((item) => item.caseSet.caseset)).toEqual(["doctor_model", "doctor_http", "local_cases", "plugin_cases"]);
    expect((await selectDoctorCases({ catalog, command: "perf", caseSetId: "plugin_cases" }))?.cases.map((item) => item.id)).toEqual(["probe"]);
    expect((await selectDoctorCases({ catalog, command: "http", caseSetId: "local_cases" }))?.cases.map((item) => item.id)).toEqual(["local_ping"]);
    expect((await selectDoctorCases({ catalog, command: "perf", caseSetId: "local_cases" }))?.cases.map((item) => item.id)).toEqual(["local_chat"]);
    expect((await selectDoctorCases({ catalog, command: "eval", caseSetId: "local_cases" }))?.cases.map((item) => item.id)).toEqual(["local_chat"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("host registry discovers kinds across Core, Plugin, Service and local owners", () => {
  const plugin: PluginDefinition = {
    id: "fixture", version: "1", extensions: [{ id: "plugin.custom", kind: "custom" }],
    services: createServiceCatalog([{
      name: "chat", component: { name: "chat", repository: { forge: { name: "test" }, path: "chat" } }, workloads: [],
      extensions: [{ id: "service.custom", kind: "custom", access: {}, run: withSummary({ title: "Custom", fields: [] }, async () => null) }],
    }]),
  };
  const registry = createDoctorExtensionRegistry(plugin, [{ id: "local.custom", kind: "custom" }]);
  expect(registry.extensions("case.catalog").map((item) => item.owner)).toEqual(["core", "core"]);
  expect(registry.extensions("custom").map((item) => item.owner)).toEqual(["local", "plugin:fixture", "service:chat"]);
});
