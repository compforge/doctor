import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SSEOperation, graphFromServices } from "@compforge/harness-common";
import { bindService, createServiceCatalog } from "@compforge/doctor-plugin";
import { buildCallgraph, writeRunData, Engine, loadRun } from "@compforge/perf-harness";
import { cleanupTemporaryArtifacts } from "../src/app/delivery";
import { commandExitCode } from "../src/app/command";
import { CommandContext, CommandInputError, CommandStatus } from "../src/command";
import { perfAdapterFromCaseFactory } from "../src/perf";
import { perfCommand } from "../src/perf/command";
import { collectPerfMetrics, observePerf, preparePerfMetrics, perfMetricSource, perfMetricsComplete } from "../src/perf/observations";
import { writePerfMetadata } from "../src/perf/output";
import { writePerfReport } from "../src/perf/report";

const operation = new SSEOperation({ serviceName: "chat", name: "chat", method: "POST", path: "/chat",
  observes: [{ type: "metricdb", metrics: { qps: { category: "red:qps", expression: 'sum(rate(chat_total{namespace="declared-scope"}[$window]))', unit: "rps", semantics: "completed" } } }] });
const definition = { name: "chat", component: { name: "chat", repository: { forge: { name: "test" }, path: "fixture/chat" } }, workloads: [], operations: [operation],
  cases: [{ id: "chat.cases", operation: operation.id(), load: () => [] }] };
const service = bindService(definition, { name: "test" });

function backendDetection(url: URL): Response | undefined {
  if (url.searchParams.get("query") !== "increase_prometheus(vector(0)[1m:1m])") return;
  return Response.json({status:"error",errorType:"bad_data",error:'unknown function with name "increase_prometheus"'}, {status:400});
}


test("Case sources statically reference owned Operations without runner callbacks", () => {
  const catalog = createServiceCatalog([definition]);
  expect(catalog.operation(catalog.caseSources()[0]!.source.operation!).operation).toBe(operation);
  expect(() => createServiceCatalog([{ ...definition, cases: [{ ...definition.cases[0]!, operation: "operation:chat/missing" }] }])).toThrow("Missing Service Operation");
  expect(() => createServiceCatalog([{ ...definition, operations: [operation, operation] }])).toThrow("Duplicate Operation");
});


test("live perf requires a metric source before loading the plugin or selecting cases", async () => {
  let loaded = false;
  const context = new CommandContext({}, {
    name: "qa", configPath: "/tmp/qa.yaml", pluginConfig: {}, value: {readonly: true},
  }, { loadPlugin: async () => { loaded = true; throw new Error("unexpected plugin load"); } });
  for (const qps of ["0", "1"]) {
    const result = await perfCommand.run(context, { qps });
    expect(commandExitCode(result)).toBe(2);
    const reason = "reason" in result ? result.reason : "";
    for (const hint of ["/tmp/qa.yaml", "profiles.qa", "metricdb.url", "--prometheus <url>"]) expect(reason).toContain(hint);
    expect(result.artifacts).toEqual([]);
  }
  expect(loaded).toBe(false);
});

test("empty offline paths are usage errors and never enter online preparation", async () => {
  const context = new CommandContext({}, undefined, {
    loadPlugin: async () => { throw new Error("empty --from must not load a Plugin"); },
  });
  for (const from of ["", "   "]) {
    const result = await perfCommand.run(context, { from });
    expect(commandExitCode(result)).toBe(2);
    expect("reason" in result && result.reason).toBe("--from 不能为空");
    expect(result.artifacts).toEqual([]);
  }
});

/** @case id=perf_external_replay,desc=`Declared Cases share one API`,expect=`Sampled Case payloads and saved request facts survive metric gaps; replay performs no external I/O` */
test("two Chat Cases share identity; external metrics and offline replay preserve request facts", async () => {
  let requests = 0, metrics = 0;
  const receivedInputs: unknown[] = [];
  let response: "observed" | "missing" | "error" = "observed";
  const directory = mkdtempSync(join(tmpdir(), "doctor-perf-observations-"));
  const server = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url);
    const detection = backendDetection(url); if (detection) return detection;
    if (url.pathname === "/chat") { requests++; receivedInputs.push(await request.json()); return new Response('data: {"done":true}\n\n', { headers: { "Content-Type": "text/event-stream" } }); }
    if (url.pathname === "/api/v1/query_range") return Response.json({
      status:"success", data:{resultType:"matrix", result:[{metric:{},values:[[Number(url.searchParams.get("start")), "0"]]}]},
    });
    expect(url.pathname).toBe("/api/v1/query"); metrics++;
    expect(readFileSync(join(directory, "run.json"), "utf8")).toContain("source_url");
    if (response === "error") return new Response("upstream failed", { status: 503 });
    return Response.json({ status: "success", data: { resultType: "vector", result: response === "missing" ? [] : [{ metric: {}, value: [Number(url.searchParams.get("time")), "0"] }] } });
  } });
  const context = new CommandContext({}, { name: "test", configPath: "", pluginConfig: {}, value: { readonly: true, metricdb: { url: server.url.toString() } } },
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
    const noProbes = await observePerf(run, directory, [], context);
    expect(noProbes.metricsComplete).toBe(true);
    const unavailable = await observePerf(run, directory, [operation], noSource);
    expect(unavailable.metricsComplete).toBe(false);
    expect(unavailable.metricIssues?.join()).toContain("未配置 metricdb");
    expect(metrics).toBe(0);
    const before = readFileSync(join(directory, "requests.jsonl"), "utf8");
    const persisted = before.trim().split("\n").map(line => JSON.parse(line));
    expect(persisted).toHaveLength(requests);
    expect(receivedInputs).toEqual(persisted.map(row => cases.cases.find(item => item.id === row.request.case_id)!.input));
    expect(persisted.map(row => row.operation_run.id)).toEqual(run.executions.flatMap(arm => arm.operation_runs.map(item => item.id)));
    for (const row of persisted) {
      expect(row.request).toMatchObject({ state: "finished", operation_run_id: row.operation_run.id });
      expect(cases.cases.map(item => item.id)).toContain(row.request.case_id);
      expect(row.operation_run).toMatchObject({
        service: { name: "chat" }, operation: { name: "chat", method: "POST", path: "/chat" },
        outcome: { status: 200, meta: { trace_id: "manual-follow-up" } },
      });
    }
    expect(before).not.toContain('"observes"');
    expect(before).not.toContain('"calls"');
    const automatic = await observePerf(run, directory, [operation], context);
    expect(automatic).toEqual({ metricsComplete: true, metricIssues: [] });
    expect(metrics).toBeGreaterThan(0);
    expect(perfMetricsComplete(run)).toBe(true);
    expect(JSON.stringify(buildCallgraph(run))).toContain('"value":0');
    expect(readFileSync(writePerfReport({ run, outputDir: directory, metricsComplete: true }), "utf8")).toContain("Callgraph");
    expect(existsSync(join(directory, "callgraph.json"))).toBe(false);
    const invalid = new SSEOperation({ serviceName: "chat", name: "missing-parameter", method: "POST", path: "/other",
      observes: [{ type: "metricdb", metrics: { qps: { category: "red:qps", expression: 'sum(rate(chat_total{tenant={{tenant}}}[$window]))', unit: "rps", semantics: "completed" } } }] });
    const partial = await observePerf(mixedRun, directory, [invalid, operation], context);
    expect(partial.metricsComplete).toBe(false);
    expect(partial.metricIssues?.join()).toContain(invalid.id());
    expect(perfMetricsComplete(mixedRun)).toBe(true);
    expect(readFileSync(writePerfReport({ run: mixedRun, outputDir: directory, ...partial }), "utf8")).toContain("指标覆盖明细");
    response = "missing";
    const source = await perfMetricSource(context);
    if (!source) throw new Error("fixture Prometheus source missing");
    await collectPerfMetrics(run, directory, source, context.signal);
    expect(perfMetricsComplete(run)).toBe(false);
    expect(JSON.stringify(buildCallgraph(run))).toContain('"status":"missing"');
    response = "error";
    const failed = await observePerf(failedRun, directory, [operation], context);
    expect(failed.metricsComplete).toBe(false);
    expect(failed.metricIssues?.join()).toContain("查询失败");
    expect(JSON.stringify(buildCallgraph(failedRun))).toContain('"status":"error"');
    expect(JSON.stringify(loadRun(directory).executions[0]!.prometheus_observations)).toContain("MetricDB HTTP 503");
    for (const invalid of ["{", '{"schema":2}', "null"]) {
      writeFileSync(join(directory, "perf.json"), invalid);
      const rejected = await perfCommand.run(context, { from: directory });
      artifactPaths.push(...rejected.artifacts.map(artifact => artifact.path));
      expect(commandExitCode(rejected)).toBe(2);
      expect("reason" in rejected && rejected.reason).toContain(join(directory, "perf.json"));
      expect(rejected.artifacts).toEqual([]);
    }
    // Recorded queries all succeeded; only Doctor metadata retains the skipped Operation gap.
    writeRunData(mixedRun, directory);
    const metadata = { caseSource: { service: "chat", source: "chat.cases" }, operation: operation.id(), caseIds: cases.cases.map(item => item.id),
      caseFacets: { difficulty: { ordered: true, values: ["simple", "medium", "complex"] } } };
    writePerfMetadata(directory, metadata, partial);
    expect(JSON.parse(readFileSync(join(directory, "perf.json"), "utf8"))).toEqual({ schema: 1, ...metadata, ...partial });
    expect(readFileSync(join(directory, "requests.jsonl"), "utf8")).toBe(before);
    const counts = [requests, metrics];
    const replay = await perfCommand.run(noSource, { from: directory });
    artifactPaths.push(...replay.artifacts.map(artifact => artifact.path));
    const replayed = replay.output;
    expect(replayed?.run.run_id).toBe(run.run_id);
    expect(replayed?.metricsComplete).toBe(false);
    expect(replayed?.metricIssues).toEqual(partial.metricIssues);
    expect(replayed?.caseFacets).toEqual(metadata.caseFacets);
    expect(replay.status).toBe(CommandStatus.Partial);
    expect([requests, metrics]).toEqual(counts);
    expect(readFileSync(join(replayed!.outputDir, "requests.jsonl"), "utf8")).toBe(before);
    rmSync(join(directory, "perf.json"));
    const fallback = await perfCommand.run(context, { from: directory });
    artifactPaths.push(...fallback.artifacts.map(artifact => artifact.path));
    expect(fallback.status).toBe(CommandStatus.Ok);
    expect(fallback.output?.metricsComplete).toBe(true);
    expect(fallback.output?.caseFacets).toBeUndefined();
    expect([requests, metrics]).toEqual(counts);
    expect(loadRun(directory).executions[0]!.operation_runs[0]!.operation.id()).toBe(operation.id());
  } finally {
    server.stop(true); await context.disposeClients(); await noSource.disposeClients();
    cleanupTemporaryArtifacts([...artifactPaths, ...context.artifacts.list().map(artifact => artifact.path)]);
    rmSync(directory, { recursive: true, force: true });
  }
});

/** @case Natural traffic observation requires only a Case/Operation and metric source, without business access. */
test("QPS zero observes all registered observations without Kubernetes, identity, runner or approval", async () => {
  const directory=mkdtempSync(join(tmpdir(),"doctor-natural-perf-"));
  let queries=0;
  const server=Bun.serve({port:0,fetch(request) {
    const url=new URL(request.url);const detection=backendDetection(url);if(detection)return detection;
    if (url.pathname.endsWith("/status/config")) return Response.json({status:"success",data:{yaml:
      "global: {scrape_interval: 1m}\nscrape_configs: [{job_name: chat-pool, scrape_interval: 15s}]"}});
    if (url.pathname.endsWith("/targets")) return Response.json({status:"success",data:{activeTargets:[
      {labels:{service:"chat", namespace:"production"}, scrapePool:"chat-pool", scrapeUrl:"http://private", health:"up"},
      {labels:{service:"chat", namespace:"elsewhere"}, scrapeInterval:"5m", scrapeUrl:"http://unrelated"},
    ],droppedTargets:[]}});
    if (url.pathname === "/api/v1/query_range") return Response.json({status:"success", data:{resultType:"matrix",
      result:[{metric:{}, values:[[Number(url.searchParams.get("start")), "7"]]}]}});
    expect(url.pathname).toBe("/api/v1/query");queries++;
    return Response.json({status:"success",data:{resultType:"vector",result:[{metric:{},value:[Number(url.searchParams.get("time")),"7"]}]}});
  }});
  const depth = {type:"metricdb",metrics:{depth:{unit:"count",expression:"queue_depth{app={{service}}}"}}};
  const other = new SSEOperation({serviceName:"other",name:"work",method:"POST",path:"/work",observes:operation.observes});
  const plugin={id:"test",version:"1",services:createServiceCatalog([
    {...definition,cases:[{id:"chat.cases",operation:operation.id(),load:()=>{throw new Error("纯观测不应加载 Case")}}]},
    {...definition,name:"other",operations:[other],cases:[],observes:[depth],workloads:[{name:"main",observes:[depth],platform:"kubernetes",location:{kind:"service",name:"worker"}}]},
  ])};
  const context=new CommandContext({}, {name:"production",configPath:"",pluginConfig:{},value:{readonly:true,
    namespace:"production",metricdb:{url:server.url.toString()}}}, {plugin});
  try {
    const result=await perfCommand.run(context,{service:"chat",qps:"0",hold:"0.03"});
    expect({status:result.status, reason:"reason" in result ? result.reason : undefined}).toEqual({status:CommandStatus.Ok,reason:undefined});
    expect(queries).toBeGreaterThanOrEqual(4);
    const snapshot = result.output!.scrape;
    expect(snapshot).toMatchObject({recommendedHoldSeconds:60, groups:[{pool:"chat-pool", intervalSeconds:15, intervalSource:"config"}]});
    const saved = readFileSync(join(result.output!.outputDir, "perf.json"), "utf8");
    expect(JSON.parse(saved).scrape).toEqual(snapshot);
    expect(saved).not.toContain("http://private");
    const offline = await perfCommand.run(context, {from:result.output!.outputDir});
    expect(offline.output!.scrape).toEqual(snapshot);
    expect(readFileSync(writePerfReport(offline.output!), "utf8")).toContain("hold 0.03s 短于 4 个抓取周期");
    const run=result.output!.run;
    expect(run.entry_ids).toEqual([operation.id()]);
    expect(run.case_ids).toEqual([]);
    expect(run.case_entries).toEqual({});
    const ranges = run.executions[0]!.prometheus_observations?.filter(query => query.step_s !== null);
    expect(ranges?.filter(q=>q.labels.operation).map(q=>q.labels.operation).sort()).toEqual([operation.id(), other.id()].sort());
    const depths = ranges!.filter(q => q.expression === 'queue_depth{app="other"}');
    expect(depths.map(q => [q.metric, q.labels])).toEqual([
      ["prometheus_query.service:other.depth", {service:"other"}],
      ["prometheus_query.workload:other/main.depth", {service:"other", workload:"main"}],
    ]);
    const resources = ranges!.filter(q => !q.labels.operation && q.expression !== 'queue_depth{app="other"}');
    expect(resources).toHaveLength(6);
    expect(resources.every(q => q.labels.service === "other" && q.expression.includes('namespace="production"') &&
      q.expression.includes('label_kubernetes_io_service_name="worker"') &&
      q.expression.includes('endpoint="worker"') && q.expression.includes('count by (namespace,pod_ip)'))).toBe(true);
    expect(resources.map(q=>q.metric)).toContain("prometheus_query.service:other.mem_limit");
    expect(run.executions[0]!.arm.load.max_inflight).toBeUndefined();
    expect(run.executions[0]!.requests).toEqual([]);
    expect(run.executions[0]!.phases.map(p=>p.kind)).toEqual(["hold"]);
    const graph=buildCallgraph(run)!;
    expect(graph.arms[0]!.windows[0]!.nodes).toHaveLength(2);
    expect(graph.arms[0]!.windows[0]!.nodes.every(n=>n.properties.perf.metrics.qps!.value===7)).toBe(true);
    const file=writePerfReport(result.output!);
    const html=readFileSync(file,"utf8");
    expect(html).toContain("Case entry");expect(html).toContain("Full graph");
    expect(html).toContain(">Overview</button>");
    expect(html).toContain(">Metrics</button>");
    expect(html).toContain("<summary>请求 RED</summary>");
    expect(html).toContain(">Resources</button>");
    expect(html).toContain('"name":"cpu_usage"');
    expect(html).toContain('"name":"mem_limit"');
    expect(html).toContain('id="callgraph-menu"');
    expect(html).toContain("抓取任务 chat-pool");
    expect(html).toContain('<td data-v="N/A">N/A</td>');
  } finally {await context.disposeClients();server.stop(true);cleanupTemporaryArtifacts(context.artifacts.list().map(a=>a.path));rmSync(directory,{recursive:true,force:true});}
});

/** Metric configuration is checked before running; preparation never sends a history query. */
test("metric preflight detects backend without querying application metrics", async () => {
  let calls = 0;
  const server = Bun.serve({ port: 0, fetch: request => {
    calls++; const response = backendDetection(new URL(request.url));
    expect(response).toBeDefined(); return response!;
  } });
  const missing = new CommandContext({});
  const context = new CommandContext({}, {name:"test",configPath:"",pluginConfig:{},value:{readonly:true,
    metricdb:{url:server.url.toString()}}});
  try {
    const unavailable = await preparePerfMetrics([operation], missing);
    expect(unavailable.issues.join()).toContain("未配置 metricdb");
    const ready = await preparePerfMetrics([operation], context);
    expect(ready.issues).toEqual([]);
    expect(ready.probes.length).toBeGreaterThan(0);
    expect(calls).toBe(1);
  } finally { await context.disposeClients(); await missing.disposeClients(); server.stop(true); }
});

/** @case A declared RED observation does not guarantee metric storage; successful siblings remain usable. */
test("natural observation preserves independent observed, missing and failed RED metrics", async () => {
  const red = new SSEOperation({serviceName:"chat",name:"chat",method:"POST",path:"/chat",observes:[{
    type:"metricdb",metrics:{qps:{category:"red:qps",unit:"rps",expression:"fixture_qps"},
      p95:{category:"red:p95",unit:"s",expression:"fixture_latency"},error_rate:{category:"red:error_rate",unit:"ratio",expression:"fixture_errors"}},
  }]});
  const server = Bun.serve({port:0,fetch: request => {
    const url = new URL(request.url), detection = backendDetection(url); if (detection) return detection;
    const expression = url.searchParams.get("query");
    if (expression === "fixture_latency") return new Response("unavailable",{status:503});
    return Response.json({status:"success",data:{resultType:"vector",result:expression === "fixture_errors" ? []
      : [{metric:{},value:[Number(url.searchParams.get("time")),"7"]}]}});
  }});
  const plugin = {id:"fixture",version:"1",services:createServiceCatalog([{...definition,operations:[red],
    cases:[{id:"chat.cases",operation:red.id(),load:()=>[{caseset:"chat",cases:[{id:"natural",input:{}}]}]}],
  }])};
  const context = new CommandContext({}, {name:"test",configPath:"",pluginConfig:{},value:{readonly:true,
    metricdb:{url:server.url.toString()}}},{plugin});
  try {
    const result = await perfCommand.run(context,{qps:"0",hold:"0.02"});
    expect(result.status).toBe(CommandStatus.Partial);
    const metrics = buildCallgraph(result.output!.run)!.arms[0]!.windows[0]!.nodes[0]!.properties.perf.metrics;
    expect(metrics.qps).toMatchObject({status:"observed",value:7});
    expect(metrics.p95).toMatchObject({status:"error",value:null,reason:"query_error"});
    expect(metrics.error_rate).toMatchObject({status:"missing",value:null,reason:"empty_result"});
    const coverage = result.output!.metricIssues!.join("\n");
    expect(coverage).toContain("查询成功，当前窗口无可计算值");
    expect(coverage).toContain("只有 1 个采样点");
    expect(coverage).toContain("属预期情况");
    expect(coverage).toContain("不能仅凭此确认原因");
    expect(readFileSync(writePerfReport(result.output!), "utf8")).toContain("指标覆盖明细");
    expect(result.output!.metricIssues?.join()).toContain("p95：查询失败");
  } finally {await context.disposeClients();server.stop(true);cleanupTemporaryArtifacts(context.artifacts.list().map(a=>a.path));}
});
