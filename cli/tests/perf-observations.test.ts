import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SSEOperation, graphFromServices } from "@compforge/harness-common";
import { bindService, createServiceCatalog } from "@compforge/doctor-plugin";
import { buildCallgraph, writeRunData, Engine, loadRun } from "@compforge/perf-harness";
import { cleanupTemporaryArtifacts } from "../src/app/delivery";
import { CommandContext } from "../src/command";
import { perfAdapterFromCaseFactory } from "../src/perf";
import { perfCommand } from "../src/perf/command";
import { collectPerfMetrics, observePerf, perfMetricSource, perfMetricsComplete } from "../src/perf/observations";
import { writePerfReport } from "../src/perf/report";

const operation = new SSEOperation({ serviceName: "chat", name: "chat", method: "POST", path: "/chat",
  probes: [{ type: "prometheus", metrics: { qps: { expression: 'sum(rate(chat_total{namespace={{namespace}}}[$window]))', unit: "rps", semantics: "completed" } } }] });
const definition = { name: "chat", component: { name: "chat", repository: { forge: { name: "test" }, path: "fixture/chat" } }, workloads: [], operations: [operation],
  cases: [{ id: "chat.cases", operation: operation.id(), load: () => [] }] };
const service = bindService(definition, { name: "test" });

test("Case sources statically reference owned Operations without runner callbacks", () => {
  const catalog = createServiceCatalog([definition]);
  expect(catalog.operation(catalog.caseSources()[0]!.source.operation!).operation).toBe(operation);
  expect(() => createServiceCatalog([{ ...definition, cases: [{ ...definition.cases[0]!, operation: "operation:chat/missing" }] }])).toThrow("Missing Service Operation");
  expect(() => createServiceCatalog([{ ...definition, operations: [operation, operation] }])).toThrow("Duplicate Operation");
});

/** @case id=perf_external_replay,desc=`Two Cases enter one API`,expect=`Frozen query plan and requests survive metric gaps; replay does not load Plugin or send requests` */
test("two Chat Cases share identity; external metrics and offline replay preserve request facts", async () => {
  let requests = 0, metrics = 0;
  let response: "observed" | "missing" | "error" = "observed";
  const directory = mkdtempSync(join(tmpdir(), "doctor-perf-observations-"));
  const server = Bun.serve({ port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/chat") { requests++; return new Response('data: {"done":true}\n\n', { headers: { "Content-Type": "text/event-stream" } }); }
    expect(url.pathname).toBe("/api/v1/query"); metrics++;
    expect(readFileSync(join(directory, "run.json"), "utf8")).toContain("source_url");
    if (response === "error") return new Response("upstream failed", { status: 503 });
    return Response.json({ status: "success", data: { resultType: "vector", result: response === "missing" ? [] : [{ metric: {}, value: [Number(url.searchParams.get("time")), "0"] }] } });
  } });
  const context = new CommandContext({}, { name: "test", configPath: "", pluginConfig: {}, value: { readonly: true, prometheus: { url: server.url.toString(), concurrency: 2 } } },
    { loadPlugin: async () => { throw new Error("offline replay must not load Plugin"); } });
  const artifactPaths: string[] = [];
  const noSource = new CommandContext({}, { name: "test", configPath: "", pluginConfig: {}, value: { readonly: true } });
  try {
    const cases = { caseset: "chat", cases: [{ id: "greeting", input: { query: "你好" } }, { id: "python", input: { query: "用 Python 计算下 1+1" } }] };
    const run = await new Engine({ service, graph: graphFromServices([service]).toJSON(), caseSet: cases,
      ...perfAdapterFromCaseFactory("chat.cases", async () => ({
        run: async ({ input, signal }) => {
          const result = await fetch(new URL("/chat", server.url), { method: "POST", body: JSON.stringify(input.input), signal });
          await result.text();
          return { status: result.status, durationMs: 1, events: 1, nbytes: 0, metrics: {}, meta: { trace_id: "manual-follow-up" } };
        }, classify: () => ({ ok: true }),
      }), operation),
      loads: [{ request_rate: 100, max_inflight: 1, hold_s: 0.06 }],
    }).run();
    expect(requests).toBeGreaterThan(0);
    expect(new Set(run.executions.flatMap(arm => arm.operation_runs.map(item => item.operation.id())))).toEqual(new Set([operation.id()]));
    writeRunData(run, directory);
    const mixedRun = loadRun(directory), failedRun = loadRun(directory);
    const noProbes = await observePerf(run, directory, [], context, "qa");
    expect(noProbes.metricsComplete).toBe(true);
    const unavailable = await observePerf(run, directory, [operation], noSource, "qa");
    expect(unavailable.metricsComplete).toBe(false);
    expect(unavailable.metricIssues?.join()).toContain("未配置 Prometheus");
    expect(metrics).toBe(0);
    const before = readFileSync(join(directory, "requests.jsonl"), "utf8");
    expect(before).not.toContain('"probes"');
    expect(before).not.toContain('"calls"');
    const automatic = await observePerf(run, directory, [operation], context, 'qa"safe');
    expect(automatic).toEqual({ metricsComplete: true, metricIssues: [] });
    expect(metrics).toBeGreaterThan(0);
    expect(perfMetricsComplete(run)).toBe(true);
    expect(JSON.stringify(buildCallgraph(run))).toContain('"value":0');
    expect(readFileSync(writePerfReport({ run, outputDir: directory, metricsComplete: true }), "utf8")).toContain("Callgraph");
    expect(existsSync(join(directory, "callgraph.json"))).toBe(false);
    const invalid = new SSEOperation({ serviceName: "chat", name: "missing-parameter", method: "POST", path: "/other",
      probes: [{ type: "prometheus", metrics: { qps: { expression: 'sum(rate(chat_total{tenant={{tenant}}}[$window]))', unit: "rps", semantics: "completed" } } }] });
    const partial = await observePerf(mixedRun, directory, [invalid, operation], context, "qa");
    expect(partial.metricsComplete).toBe(false);
    expect(partial.metricIssues?.join()).toContain(invalid.id());
    expect(perfMetricsComplete(mixedRun)).toBe(true);
    expect(readFileSync(writePerfReport({ run: mixedRun, outputDir: directory, ...partial }), "utf8")).toContain("指标覆盖缺口");
    response = "missing";
    const source = await perfMetricSource(context);
    if (!source) throw new Error("fixture Prometheus source missing");
    await collectPerfMetrics(run, directory, source, context.signal);
    expect(perfMetricsComplete(run)).toBe(false);
    expect(JSON.stringify(buildCallgraph(run))).toContain('"status":"missing"');
    response = "error";
    const failed = await observePerf(failedRun, directory, [operation], context, "qa");
    expect(failed.metricsComplete).toBe(false);
    expect(failed.metricIssues?.join()).toContain("部分指标查询失败");
    expect(JSON.stringify(buildCallgraph(failedRun))).toContain('"status":"error"');
    writeFileSync(join(directory, "perf.json"), JSON.stringify({ schema: 1, ...failed }));
    expect(readFileSync(join(directory, "requests.jsonl"), "utf8")).toBe(before);
    const counts = [requests, metrics];
    const replay = await perfCommand.run(context, { from: directory });
    artifactPaths.push(...replay.artifacts.map(artifact => artifact.path));
    const replayed = replay.output?.services[0]?.result.output;
    expect(replayed?.run.run_id).toBe(run.run_id);
    expect(replayed?.metricsComplete).toBe(false);
    expect(replayed?.metricIssues).toEqual(failed.metricIssues);
    expect([requests, metrics]).toEqual(counts);
    expect(readFileSync(join(replayed!.outputDir, "requests.jsonl"), "utf8")).toBe(before);
    expect(JSON.stringify(loadRun(directory).executions[0]!.prometheus_observations)).toContain("Prometheus HTTP 503");
    expect(loadRun(directory).executions[0]!.operation_runs[0]!.operation.id()).toBe(operation.id());
  } finally {
    server.stop(true); await context.disposeClients(); await noSource.disposeClients();
    cleanupTemporaryArtifacts([...artifactPaths, ...context.artifacts.list().map(artifact => artifact.path)]);
    rmSync(directory, { recursive: true, force: true });
  }
});
