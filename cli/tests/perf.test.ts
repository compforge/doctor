import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run, TrialContext } from "@compforge/perf-harness";
import {
  parsePerfLevels,
  parsePerfOutputFormat,
  perfLevelsThrough,
  resolvePerfConfig,
} from "../src/perf/config";
import {
  formatPerfCaseMix,
  resolvePerfRequestIdentity,
  resolveUserSearchPromptAction,
  deliverPerfBundle,
  preparePerfOutput,
  selectUserFromSearch,
  selectPerfSamples,
  workloadFromCaseRunner,
} from "../src/perf";
import { perfEvidenceStatus, writePerfReport } from "../src/perf/report";

test("perf defaults scan concurrency 5 through 20 with bounded requests", () => {
  const config = resolvePerfConfig({}, new Date("2026-01-02T03:04:05"));
  expect(config).toMatchObject({
    levels: [5, 10, 15, 20],
    rampSeconds: 10,
    holdSeconds: 60,
    maxRequests: 100,
    abortErrorRate: 0.1,
    breakerMinN: 10,
    requestTimeoutMs: 180_000,
    traceSamples: 10,
    outputFormat: "default",
    bundleName: "doctor-perf-20260102-030405",
  });
  expect(() => parsePerfLevels("5,0,20")).toThrow("--levels");
  expect(() => parsePerfLevels("5,55")).toThrow("1-50");
  expect(perfLevelsThrough(1)).toEqual([1]);
  expect(perfLevelsThrough(20)).toEqual([5, 10, 15, 20]);
  expect(perfLevelsThrough(50)).toEqual([5, 10, 15, 20, 25, 30, 35, 40, 45, 50]);
  expect(() => perfLevelsThrough(15)).toThrow("只支持");
  expect(parsePerfOutputFormat("bundle")).toBe("bundle");
  expect(() => parsePerfOutputFormat("json")).toThrow("html 或 bundle");
  expect(resolvePerfConfig({ format: "bundle", output: "perf-result" }, new Date("2026-01-02T03:04:05")))
    .toMatchObject({ outputFormat: "bundle", outputDir: "perf-result", traceSamples: 10 });
  expect(() => resolvePerfConfig({ format: "html", output: "perf.tar.gz" })).toThrow("不能使用");
  expect(() => resolvePerfConfig({ format: "bundle", output: "perf.html" })).toThrow("不能使用");
});

test("Perf bundle archives the complete linked report directory", async () => {
  const parent = mkdtempSync(join(tmpdir(), "doctor-perf-output-test-"));
  const archive = join(parent, "perf.tar.gz");
  const output = preparePerfOutput(resolvePerfConfig({
    format: "bundle",
    output: archive,
  }, new Date("2026-01-02T03:04:05")));
  try {
    writeFileSync(join(output.outputDir, "perf.html"), "perf");
    writeFileSync(join(output.outputDir, "report.html"), "perf");
    writeFileSync(join(output.outputDir, "metric.html"), "metric");
    writeFileSync(join(output.outputDir, "sample-01-trace.html"), "trace");
    writeFileSync(join(output.outputDir, "sample-01-log.html"), "log");
    const packed = await deliverPerfBundle(output);
    expect(packed?.ok).toBe(true);
    expect(existsSync(archive)).toBe(true);
    const listing = Bun.spawnSync(["tar", "-tzf", archive]).stdout.toString();
    expect(listing).toContain("doctor-perf-20260102-030405/perf.html");
    expect(listing).toContain("doctor-perf-20260102-030405/report.html");
    expect(listing).toContain("doctor-perf-20260102-030405/metric.html");
    expect(listing).toContain("doctor-perf-20260102-030405/sample-01-trace.html");
    expect(listing).toContain("doctor-perf-20260102-030405/sample-01-log.html");
    expect(output.temporaryRoot && existsSync(output.temporaryRoot)).toBe(false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
    if (output.temporaryRoot) rmSync(output.temporaryRoot, { recursive: true, force: true });
  }
});

test("perf trial output describes the active Case mix and Facets", () => {
  expect(formatPerfCaseMix([
    {
      case: {
        id: "ordinary_chat",
        input: { query: "你好" },
        facets: { difficulty: "simple", task_type: "greeting" },
      },
      weight: 1,
    },
    {
      case: {
        id: "python_addition",
        input: { query: "请调用 Python 工具计算 1+1，并返回结果" },
        facets: { difficulty: "medium", task_type: "tool_execution" },
      },
      weight: 2,
    },
  ])).toBe(
    "[perf]   case=ordinary_chat weight=1 facets=difficulty=simple, task_type=greeting\n"
      + "[perf]   case=python_addition weight=2 facets=difficulty=medium, task_type=tool_execution\n",
  );
});

test("Service Case runner maps one trigger into one shared Outcome", async () => {
  const lifecycle: string[] = [];
  const workload = workloadFromCaseRunner({
    setup: async () => { lifecycle.push("setup"); },
    trigger: async ({ case: selected }) => ({
      status: 200,
      durationMs: 7000,
      metrics: { first_token_ms: 6500 },
      meta: { trace_id: "trace-1", case_input: selected.input },
    }),
    classify: (observation) => ({ ok: observation.status === 200 }),
    deactivate: async () => { lifecycle.push("deactivate"); },
    cleanup: async () => { lifecycle.push("cleanup"); },
  });
  const context: TrialContext = {
    subject: { name: "chat", target: {} },
    arm: {
      id: "5c",
      resources: {},
      load: { model: "closed", schedule: { start_level: 0, stages: [] } },
    },
    run_id: "run-1",
    signal: new AbortController().signal,
  };
  await workload.setup?.(context);
  const outcome = await workload.fire({
    ...context,
    case: { id: "ordinary", input: { query: "hello" } },
  });
  await workload.deactivate?.(context);
  await workload.cleanup?.(context);
  expect(outcome).toMatchObject({
    status: 200,
    duration_ms: 7000,
    metrics: { first_token_ms: 6500 },
    meta: { trace_id: "trace-1", case_input: { query: "hello" } },
  });
  expect(workload.judge?.(outcome)).toEqual({ ok: true, error_kind: undefined });
  expect(lifecycle).toEqual(["setup", "deactivate", "cleanup"]);
});

test("Perf fills missing tenant and user identity from the declared directory", async () => {
  const tenants = [{ id: "tenant-1", name: "alpha", displayName: "Alpha" }];
  const users = [{ id: "user-1", name: "alice", displayName: "Alice" }];
  const searches: unknown[] = [];
  expect(await resolvePerfRequestIdentity({
    configured: {},
    directory: {
      listActive: async () => tenants,
      getByName: async () => tenants[0]!,
      searchActiveUsers: async (input) => {
        searches.push(input);
        return { users, total: 1 };
      },
    },
    promptTenant: async (choices) => choices[0],
    promptUser: async ({ search }) => (await search({
      query: "alice",
      page: 1,
      pageSize: 10,
    })).users[0],
  })).toEqual({ tenantId: "tenant-1", userId: "user-1" });
  expect(searches).toEqual([{
    tenantId: "tenant-1",
    query: "alice",
    page: 1,
    pageSize: 10,
  }]);

  expect(resolveUserSearchPromptAction(users, "1")).toEqual({
    kind: "selected",
    user: users[0],
  });
  expect(resolveUserSearchPromptAction(users, "next")).toEqual({ kind: "next" });
  expect(resolveUserSearchPromptAction(users, "bob")).toEqual({ kind: "search", query: "bob" });
});

test("Perf user selection keeps page state across next and previous commands", async () => {
  const searches: Array<{ query?: string; page: number; pageSize: number }> = [];
  const answers = ["test", "n", "p", "1"];
  const selected = await selectUserFromSearch(async (input) => {
    searches.push(input);
    return {
      users: [{ id: `user-${input.page}`, name: `user-${input.page}`, displayName: `User ${input.page}` }],
      total: 21,
    };
  }, async () => answers.shift() ?? "q");

  expect(selected?.id).toBe("user-1");
  expect(searches.map(({ page }) => page)).toEqual([1, 2, 1]);
});

test("Perf preserves configured identity and only queries missing user", async () => {
  let listedTenants = 0;
  const directory = {
    listActive: async () => {
      listedTenants += 1;
      return [];
    },
    getByName: async (name: string) => ({ id: name, name, displayName: name }),
    searchActiveUsers: async ({ tenantId }: { tenantId: string }) => ({
      users: [{
        id: `${tenantId}-user`,
        name: "user",
        displayName: "User",
      }],
      total: 1,
    }),
  };
  expect(await resolvePerfRequestIdentity({
    configured: { tenantId: "tenant-1" },
    directory,
    promptUser: async ({ search }) => (await search({ page: 1, pageSize: 10 })).users[0],
  })).toEqual({ tenantId: "tenant-1", userId: "tenant-1-user" });
  expect(listedTenants).toBe(0);
});

test("representative evidence selects slow correlation IDs and deduplicates", () => {
  const outcomes = [1000, 5000, 3000].map((firstTokenMs, index) => ({
    t: index,
    outcome: {
      status: 200,
      duration_ms: firstTokenMs + 100,
      ok: true,
      metrics: { first_token_ms: firstTokenMs },
      meta: index === 1 ? { message_id: "message-1" } : { trace_id: `trace-${index}` },
    },
  }));
  const run = {
    schema: 3,
    run_id: "run",
    experiment: "perf",
    created_at: "",
    subject: "chat",
    passed: true,
    n_trials: 1,
    trials: [{
      id: "closed/5c",
      subject: "chat",
      arm: {
        id: "closed/5c",
        resources: {},
        load: { model: "closed", schedule: { start_level: 0, stages: [] } },
      },
      started_at: "",
      finished_at: "",
      windows: [],
      stop: { reason: "deadline", inflight_at_stop: 0, interrupted: 0, force_cancelled: false },
      slo: [],
      registry: {},
      probe_errors: {},
      outcomes,
    }],
  } satisfies Run;

  expect(selectPerfSamples(run, 2, ["trace_id", "message_id"]).map((item) => item.correlationId))
    .toEqual(["message-1", "trace-2"]);
  expect(perfEvidenceStatus({
    run,
    outputDir: ".",
    metricPath: "metric.html",
    metricCode: 0,
    samples: [{
      trialId: "closed/5c",
      correlationKey: "trace_id",
      correlationId: "trace-1",
      durationMs: 5100,
      tracePath: "trace.html",
      traceCode: 0,
      logPath: "log.html",
      logCode: 1,
    }],
  })).toBe("partial");
});

test("perf report renders Facet values in their declared order", () => {
  const stats = {
    n: 1,
    n_ok: 1,
    throughput_rps: 1,
    p50_ms: 10,
    p95_ms: 10,
    p99_ms: 10,
    mean_ms: 10,
    error_rate: 0,
    error_breakdown: {},
    n_dropped: 0,
    caveats: [],
    metrics: {},
  };
  const run = {
    schema: 3,
    run_id: "run",
    experiment: "perf",
    created_at: "",
    subject: "chat",
    passed: true,
    n_trials: 1,
    trials: [{
      id: "closed/5c",
      subject: "chat",
      arm: {
        id: "closed/5c",
        resources: {},
        load: { model: "closed", schedule: { start_level: 0, stages: [] } },
      },
      started_at: "",
      finished_at: "",
      windows: [{
        id: "measurement",
        name: "measurement",
        kind: "measurement",
        start_s: 0,
        end_s: 1,
        complete: true,
        request: stats,
        by_case: {},
        by_facet: {
          difficulty: { complex: stats, simple: stats, medium: stats },
        },
        probe_metrics: {},
      }],
      stop: { reason: "deadline", inflight_at_stop: 0, interrupted: 0, force_cancelled: false },
      slo: [],
      registry: {},
      probe_errors: {},
      outcomes: [],
    }],
  } satisfies Run;
  const outputDir = mkdtempSync(join(tmpdir(), "doctor-perf-report-"));
  try {
    const report = writePerfReport({
      run,
      outputDir,
      metricPath: join(outputDir, "metric.html"),
      metricCode: 0,
      samples: [],
      caseFacets: {
        difficulty: { values: ["simple", "medium", "complex"], ordered: true },
      },
    });
    const html = readFileSync(report, "utf-8");
    expect(html).toContain("按 Facet");
    expect(html.indexOf("<td>simple</td>")).toBeLessThan(html.indexOf("<td>medium</td>"));
    expect(html.indexOf("<td>medium</td>")).toBeLessThan(html.indexOf("<td>complex</td>"));
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});
