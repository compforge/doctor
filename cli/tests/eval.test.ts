import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createServiceCatalog,
  type PluginDefinition,
  type ServiceCaseRunner,
} from "@compforge/doctor-plugin";
import type { CaseSet } from "@compforge/spec-case/model";
import { deliverCommandArtifacts } from "../src/app/delivery";
import { CommandContext } from "../src/command";
import {
  createEvalArtifact,
  evalRunName,
  executeEvalCases,
  resolveEvalConfig,
  selectEvalCases,
  selectEvalCaseSet,
  selectEvalProvider,
  writeEvalArtifact,
  type EvalRun,
} from "../src/eval";

const CASE_SET: CaseSet = {
  caseset: "ordinary-chat",
  schema_version: 1,
  focus: "ordinary chat",
  facets: { difficulty: { values: ["simple", "complex"], ordered: true } },
  cases: [{
    id: "hello",
    input: { query: "hello" },
    facets: { difficulty: "simple" },
  }, {
    id: "reason",
    input: { query: "reason" },
    facets: { difficulty: "complex" },
  }],
};

function testPlugin(): PluginDefinition {
  return {
    id: "test",
    version: "0.0.1",
    services: createServiceCatalog([{
      name: "chat",
      capabilities: {
        case: {
          endpoint: { port: 8080 },
          access: {},
          caseSets: [CASE_SET],
          createRunner: async () => ({
            run: async () => ({ status: 200, durationMs: 10 }),
            classify: () => ({ ok: true }),
          }),
        },
      },
    }]),
  };
}

test("eval config selects one canonical CaseSet and an optional Case subset", () => {
  const now = new Date("2026-01-02T03:04:05");
  expect(evalRunName(now)).toBe("doctor-eval-20260102-030405");
  expect(resolveEvalConfig({ cases: "reason,hello,reason" }, now)).toEqual({
    service: undefined,
    caseset: undefined,
    caseIds: ["reason", "hello"],
    requestTimeoutMs: 180_000,
    bundleName: "doctor-eval-20260102-030405",
  });
  expect(() => resolveEvalConfig({ format: "json" })).toThrow("html 或 bundle");
  const provider = selectEvalProvider(testPlugin(), undefined);
  const caseSet = selectEvalCaseSet(provider, undefined);
  expect(selectEvalCases(caseSet, ["reason"]).map((item) => item.id)).toEqual(["reason"]);
  expect(() => selectEvalCases(caseSet, ["missing"])).toThrow("不包含 Case");
});

test("eval executes selected Cases once and preserves protocol observations", async () => {
  const triggered: string[] = [];
  const runner: ServiceCaseRunner = {
    run: async ({ input: selected }) => {
      triggered.push(selected.id);
      if (selected.id === "reason") throw new Error("request failed");
      return {
        status: 200,
        durationMs: 12,
        metrics: { first_token_ms: 7 },
        meta: { trace_id: "trace-1" },
      };
    },
    classify: () => ({ ok: true }),
  };
  const results = await executeEvalCases(
    runner,
    CASE_SET.cases,
    "run-1",
    new AbortController().signal,
  );
  expect(triggered).toEqual(["hello", "reason"]);
  expect(results[0]).toMatchObject({
    caseId: "hello",
    protocol: { ok: true },
    correlation: { key: "trace_id", id: "trace-1" },
  });
  expect(results[1]).toMatchObject({ caseId: "reason", error: "request failed" });
});

test("eval artifact keeps CaseSet, observations and offline report in one delivery", async () => {
  const parent = mkdtempSync(join(tmpdir(), "doctor-eval-output-test-"));
  const archive = join(parent, "eval.tar.gz");
  const config = resolveEvalConfig({}, new Date("2026-01-02T03:04:05"));
  const artifact = createEvalArtifact(config);
  const run: EvalRun = {
    schema: "doctor-eval/v1",
    runId: "run-1",
    plugin: "test@0.0.1",
    service: "chat",
    caseset: CASE_SET.caseset,
    startedAt: "2026-01-02T03:04:05.000Z",
    finishedAt: "2026-01-02T03:04:06.000Z",
    cases: [{
      caseId: "hello",
      facets: { difficulty: "simple" },
      startedAt: "2026-01-02T03:04:05.000Z",
      finishedAt: "2026-01-02T03:04:05.012Z",
      observation: { status: 200, durationMs: 12, meta: { trace_id: "trace-1" } },
      protocol: { ok: true },
      correlation: { key: "trace_id", id: "trace-1" },
    }],
    evidence: {
      trace: { status: "collected", exitCode: 0 },
      log: { status: "unavailable", reason: "no log capability" },
      data: { status: "collected", exitCode: 0 },
    },
  };
  try {
    writeEvalArtifact(artifact, run, CASE_SET, "test");
    expect(readFileSync(join(artifact.path, "run.json"), "utf8")).toContain("doctor-eval/v1");
    expect(readFileSync(join(artifact.path, "caseset.json"), "utf8")).toContain("ordinary-chat");
    expect(readFileSync(join(artifact.path, "observations.jsonl"), "utf8")).toContain("trace-1");
    expect(readFileSync(join(artifact.path, "report.html"), "utf8")).toContain("不评价回答质量");

    const context = new CommandContext({});
    context.artifacts.add("eval", artifact.path);
    expect(await deliverCommandArtifacts(context, { format: "bundle", output: archive }, 0, "doctor eval"))
      .toBe(true);
    expect(existsSync(archive)).toBe(true);
    const listing = Bun.spawnSync(["tar", "-tzf", archive]).stdout.toString();
    expect(listing).toContain("eval/report.html");
    expect(listing).toContain("eval/caseset.json");
    expect(listing).toContain("eval/observations.jsonl");
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(artifact.temporaryRoot, { recursive: true, force: true });
  }
});
