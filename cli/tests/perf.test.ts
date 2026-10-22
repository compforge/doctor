import { bindService } from "@compforge/doctor-plugin";
import { readBundleExecutions } from "./bundle-fixture";
import { commandOutcome } from "../src/command";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Engine, writeRunData, loadRun, type Run, type ArmContext } from "@compforge/perf-harness";
import {
  parsePerfLevels,
  parsePerfOutputFormat,
  perfLevelsThrough,
  resolvePerfConfig,
  perfLoadPlans,
} from "../src/perf/config";
import {
  formatPerfCaseMix,
  createPerfArtifact,
  selectPerfSamples,
  perfAdapterFromCaseFactory,
} from "../src/perf";
import {
  resolveCaseRequestIdentity,
  resolveUserSearchPromptAction,
  selectUserFromSearch,
} from "../src/case";
import { perfEvidenceStatus, writePerfReport } from "../src/perf/report";
import { CommandContext } from "../src/command";
import { finalizeFixture } from "./report-fixture";

const service = bindService({
  name: "chat",
  component: { name: "chat", repository: { forge: { name: "test" }, path: "fixture/chat" } },
  workloads: [],
}, { name: "test" });

test("perf defaults scan concurrency 5 through 20 with bounded duration", () => {
  const config = resolvePerfConfig({}, new Date("2026-01-02T03:04:05"));
  expect(config).toMatchObject({
    levels: [5, 10, 15, 20],
    rampSeconds: 10,
    holdSeconds: 60,
    abortErrorRate: 0.1,
    breakerMinN: 10,
    requestTimeoutMs: 180_000,
    traceSamples: 10,
    outputFormat: "default",
    bundleName: "doctor-perf-20260102-030405",
  });
  expect(() => resolvePerfConfig({ maxRequests: "100" })).toThrow("已移除 --max-requests");
  expect(() => parsePerfLevels("5,0,20")).toThrow("--levels");
  expect(() => parsePerfLevels("5,55")).toThrow("1-50");
  expect(perfLevelsThrough(1)).toEqual([1]);
  expect(perfLevelsThrough(20)).toEqual([5, 10, 15, 20]);
  expect(perfLevelsThrough(50)).toEqual([5, 10, 15, 20, 25, 30, 35, 40, 45, 50]);
  expect(() => perfLevelsThrough(15)).toThrow("只支持");
  expect(parsePerfOutputFormat("bundle")).toBe("bundle");
  expect(() => parsePerfOutputFormat("json")).toThrow("html 或 bundle");
  expect(resolvePerfConfig({ format: "bundle", output: "perf-result" }, new Date("2026-01-02T03:04:05")))
    .toMatchObject({ outputFormat: "bundle", traceSamples: 10 });
  expect(() => resolvePerfConfig({ format: "html", output: "perf.tar.gz" })).toThrow("不能使用");
  expect(() => resolvePerfConfig({ format: "bundle", output: "perf.html" })).toThrow("不能使用");
});

test("Perf bundle archives the complete linked report directory", async () => {
  const parent = mkdtempSync(join(tmpdir(), "doctor-perf-output-test-"));
  const archive = join(parent, "perf.tar.gz");
  const artifact = createPerfArtifact(resolvePerfConfig({
    format: "bundle",
    output: archive,
  }, new Date("2026-01-02T03:04:05")));
  try {
    writeFileSync(join(artifact.path, "perf.html"), "perf");
    writeFileSync(join(artifact.path, "report.html"), "perf");
    const metricDir = join(artifact.temporaryRoot, "doctor-metric-test");
    const traceDir = join(artifact.temporaryRoot, "doctor-trace-test");
    const logDir = join(artifact.temporaryRoot, "doctor-log-test");
    for (const [dir, report] of [[metricDir, "metric"], [traceDir, "trace"], [logDir, "log"]]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "report.html"), report);
    }
    const context = new CommandContext({});
    context.artifacts.add({ command: "perf", path: artifact.path });
    context.artifacts.add({ command: "metric", path: metricDir });
    context.artifacts.add({ command: "trace", path: traceDir });
    context.artifacts.add({ command: "log", path: logDir });
    expect(await finalizeFixture(context, { format: "bundle", output: archive }, 0, "doctor perf"))
      .toBe(0);
    expect(existsSync(archive)).toBe(true);
    const listing = Bun.spawnSync(["tar", "-tzf", archive]).stdout.toString();
    const entries = listing.split(/\r?\n/).filter(Boolean);
    expect([...new Set(entries.map((entry) => entry.split("/")[0]))]).toEqual(["perf"]);
    const executions = readBundleExecutions(archive, "perf");
    expect(executions).toHaveLength(4);
    for (const command of ["perf", "metric", "trace", "log"]) {
      const execution = executions.find(entry => entry.manifest.source.command === command)!;
      expect(listing).toContain(`perf/${join(dirname(execution.path), execution.manifest.files.report!.path)}`);
    }
    expect(existsSync(artifact.temporaryRoot)).toBe(false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(artifact.temporaryRoot, { recursive: true, force: true });
  }
});

test("perf trial output describes the active Case mix and Facets", () => {
  expect(formatPerfCaseMix({
    caseset: "chat",
    schema_version: 1,
    facets: {
      difficulty: { values: ["simple", "medium"] },
      task_type: { open: true },
    },
    cases: [
      {
        id: "ordinary_chat",
        input: { query: "你好" },
        facets: { difficulty: "simple", task_type: "greeting" },
      },
      {
        id: "python_addition",
        input: { query: "请调用 Python 工具计算 1+1，并返回结果" },
        facets: { difficulty: "medium", task_type: "tool_execution" },
      },
    ],
  }, [
    { id: "ordinary_chat", weight: 1 },
    { id: "python_addition", weight: 2 },
  ])).toBe(
    "[perf]   case=ordinary_chat weight=1 facets=difficulty=simple, task_type=greeting\n"
      + "[perf]   case=python_addition weight=2 facets=difficulty=medium, task_type=tool_execution\n",
  );
});

test("Service Case runner maps one Probe into one shared Outcome", async () => {
  const lifecycle: string[] = [];
  const { runner, judge } = perfAdapterFromCaseFactory("chat", async () => ({
    setup: async () => { lifecycle.push("setup"); },
    run: async ({ input: selected }) => ({
      status: 200,
      durationMs: 7000,
      metrics: { first_token_ms: 6500 },
      meta: { trace_id: "trace-1", case_input: selected.input },
    }),
    classify: (observation) => ({ ok: observation.status === 200 }),
    deactivate: async () => { lifecycle.push("deactivate"); },
    cleanup: async () => { lifecycle.push("cleanup"); },
  }));
  const context: ArmContext = {
    service,
    arm: {
      id: "5c",
      resources: {},
      load: { request_rate: Infinity, max_inflight: 5, hold_s: 1 },
    },
    run_id: "run-1",
    signal: new AbortController().signal,
  };
  await runner.setup?.(context);
  const outcome = await runner.fire({
    ...context,
    case: { id: "ordinary", input: { query: "hello" } },
  });
  await runner.deactivate?.(context);
  await runner.cleanup?.(context);
  expect(outcome).toMatchObject({
    status: 200,
    duration_ms: 7000,
    metrics: { first_token_ms: 6500 },
    meta: { trace_id: "trace-1", case_input: { query: "hello" } },
  });
  expect(judge?.(outcome)).toEqual({ ok: true, error_kind: undefined });
  expect(lifecycle).toEqual(["setup", "deactivate", "cleanup"]);
});

test("Perf fills missing tenant and user identity from the declared directory", async () => {
  const tenants = [{ id: "tenant-1", name: "alpha", displayName: "Alpha" }];
  const users = [{ id: "user-1", name: "alice", displayName: "Alice" }];
  const searches: unknown[] = [];
  expect(await resolveCaseRequestIdentity({
    configured: {},
    interactive: true,
    directory: {
      listActive: async () => tenants,
      getByName: async () => tenants[0]!,
      searchActiveUsers: async (input) => {
        searches.push(input);
        return { users, total: 1 };
      },
    },
    commandLabel: "Perf",
    logPrefix: "perf",
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
  expect(await resolveCaseRequestIdentity({
    configured: { tenantId: "tenant-1" },
    directory,
    commandLabel: "Perf",
    logPrefix: "perf",
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
      metrics: { first_token_ms: firstTokenMs },
      meta: index === 1 ? { message_id: "message-1" } : { trace_id: `trace-${index}` },
    },
  }));
  const run: Run = {
    schema: 6,
    run_id: "run",
    experiment: "perf",
    created_at: "",
    service: "chat",
    passed: true,
    artifacts: [],
    executions: [{
      id: "closed/5c",
      service: "chat",
      arm: {
        id: "closed/5c",
        resources: {},
        load: { request_rate: Infinity, max_inflight: 5, hold_s: 1 },
      },
      started_at: "",
      finished_at: "",
      windows: [],
      stop: { reason: "deadline", inflight_at_stop: 0, interrupted: 0, force_cancelled: false },
      slo: [],
      registry: {},
      probe_errors: {},
      phase_errors: [],
      requests: outcomes.map((item, index) => ({
        id: String(index), case_id: "ordinary", scheduled_at: item.t, arrived_at: item.t,
        dispatched_at: item.t, finished_at: item.t + item.outcome.duration_ms / 1000,
        state: "finished" as const, operation_run_id: String(index), facets: {},
      })),
      operation_runs: outcomes.map((item, index) => ({ id: String(index), service, operation: { name: "chat" }, outcome: item.outcome })),
      evaluations: {},
    }],
  };

  expect(selectPerfSamples(run, 2, ["trace_id", "message_id"]).map((item) => item.correlationId))
    .toEqual(["message-1", "trace-2"]);
  run.executions[0]!.requests[1]!.state = "interrupted";
  run.executions[0]!.evaluations["0"] = { ok: false, error_kind: "sse-terminal" };
  const samples = selectPerfSamples(run, 10, ["trace_id", "message_id"]);
  expect(samples.map(item => item.correlationId)).toEqual(["trace-2", "trace-0"]);
  expect(samples[1]!.errorKind).toBe("sse-terminal");
  expect(perfEvidenceStatus({
    run,
    outputDir: ".",
    metric: commandOutcome(0),
    samples: [{
      armRunId: "closed/5c",
      correlationKey: "trace_id",
      correlationId: "trace-1",
      durationMs: 5100,
      trace: commandOutcome(0),
      log: commandOutcome(1),
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
    arrived: 1, dispatched: 1, completed: 1, succeeded: 1, n_interrupted: 0,
    arrival_rps: 1, dispatch_rps: 1, success_rps: 1, inflight_peak: 1, inflight_end: 0,
    caveats: [],
    metrics: {},
  };
  const run: Run = {
    schema: 6,
    run_id: "run",
    experiment: "perf",
    created_at: "",
    service: "chat",
    passed: true,
    artifacts: [],
    executions: [{
      id: "closed/5c",
      service: "chat",
      arm: {
        id: "closed/5c",
        resources: {},
        load: { request_rate: Infinity, max_inflight: 5, hold_s: 1 },
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
      phase_errors: [],
      requests: [],
      operation_runs: [],
      evaluations: {},
    }],
  };
  const outputDir = mkdtempSync(join(tmpdir(), "doctor-perf-report-"));
  try {
    const report = writePerfReport({
      run,
      outputDir,
      metric: commandOutcome(0),
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

/** @case id=perf_cancel_evidence,desc=`Host cancels a running Case`,expect=`Request and cleanup see the reason; schema 6 preserves interrupted facts without judging them` */
test("Perf adapter cancels active Case requests and round-trips interrupted evidence", async () => {
  const controller = new AbortController();
  const reason = new Error("doctor perf interrupted");
  let requestReason: unknown, cleanupReason: unknown, judged = 0;
  const run = await new Engine({
    service,
    ...perfAdapterFromCaseFactory("chat", async () => ({
      run: async ({ signal }) => new Promise((_, reject) => {
        signal.addEventListener("abort", () => { requestReason = signal.reason; reject(signal.reason); }, { once: true });
        controller.abort(reason);
      }),
      classify: () => { judged++; return { ok: true }; },
      cleanup: async ({ signal }) => { cleanupReason = signal.reason; },
    })),
    loads: [{ request_rate: Infinity, max_inflight: 1, hold_s: 60, cooldown_timeout_s: 60 }],
    signal: controller.signal,
  }).run();
  expect(requestReason).toBe(reason);
  expect(cleanupReason).toBe(reason);
  expect(judged).toBe(0);
  expect(run.passed).toBe(false);
  expect(run.executions[0]!.stop).toMatchObject({ reason: "aborted", interrupted: 1 });
  const directory = mkdtempSync(join(tmpdir(), "doctor-perf-cancel-"));
  try {
    writeRunData(run, directory);
    const restored = loadRun(directory);
    expect(restored.executions[0]!.requests[0]!.state).toBe("interrupted");
    expect(restored.executions[0]!.operation_runs).toHaveLength(1);
    expect(selectPerfSamples(restored, 10, ["trace_id"])).toEqual([]);
    expect(JSON.parse(readFileSync(join(directory, "evaluations.json"), "utf8")))
      .toEqual({ [run.executions[0]!.id]: {} });
    expect(readFileSync(writePerfReport({ run: restored, outputDir: directory, metric: commandOutcome(130), samples: [] }), "utf8"))
      .toContain("requests.jsonl");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Perf maps concurrency levels into explicit schema 6 ramp and hold stages", () => {
  const [load] = perfLoadPlans(resolvePerfConfig({ levels: "5", ramp: "2", hold: "3", gracefulStop: "4" }));
  expect(load).toMatchObject({
    request_rate: Infinity, max_inflight: 1, cooldown_timeout_s: 4,
    stages: [
      { kind: "ramp", duration_s: 2, request_rate: Infinity, max_inflight: 5 },
      { kind: "hold", duration_s: 3, request_rate: Infinity, max_inflight: 5 },
    ],
  });
  expect(perfLoadPlans(resolvePerfConfig({ levels: "5", ramp: "0" }))[0]!.max_inflight).toBe(5);
  expect(() => perfLoadPlans(resolvePerfConfig({ ramp: "0", hold: "0" }))).toThrow("不能同时为 0");
});
