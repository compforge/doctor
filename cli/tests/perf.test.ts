import { expect, test } from "bun:test";
import type { Run, TrialContext } from "@compforge/perf-harness";
import { parsePerfLevels, resolvePerfConfig } from "../src/perf/config";
import {
  resolvePerfRequestIdentity,
  resolveUserPromptChoice,
  selectPerfSamples,
  workloadFromCaseRunner,
} from "../src/perf";
import { perfEvidenceStatus } from "../src/perf/report";

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
    traceSamples: 2,
  });
  expect(() => parsePerfLevels("5,0,20")).toThrow("--levels");
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
  const listedTenants: string[] = [];
  expect(await resolvePerfRequestIdentity({
    configured: {},
    directory: {
      listActive: async () => tenants,
      getByName: async () => tenants[0]!,
      listActiveUsers: async (tenantId) => {
        listedTenants.push(tenantId);
        return users;
      },
    },
    promptTenant: async (choices) => choices[0],
    promptUser: async (choices) => choices[0],
  })).toEqual({ tenantId: "tenant-1", userId: "user-1" });
  expect(listedTenants).toEqual(["tenant-1"]);

  expect(resolveUserPromptChoice(users, "alice", [])).toEqual({
    kind: "selected",
    value: users[0],
  });
});

test("Perf preserves configured identity and only queries missing user", async () => {
  let listedTenants = 0;
  const directory = {
    listActive: async () => {
      listedTenants += 1;
      return [];
    },
    getByName: async (name: string) => ({ id: name, name, displayName: name }),
    listActiveUsers: async (tenantId: string) => [{
      id: `${tenantId}-user`,
      name: "user",
      displayName: "User",
    }],
  };
  expect(await resolvePerfRequestIdentity({
    configured: { tenantId: "tenant-1" },
    directory,
    promptUser: async (choices) => choices[0],
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
