import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/app/config/config";
import { CommandContext } from "../src/command";
import { perfMetricSource } from "../src/perf/observations";
import { probePerfScrape, scrapeAdvice } from "../src/perf/scrape";

/** @case Explicit profile kind drives the Perf backend without capability guesses. */
for (const kind of ["prometheus", "victoriametrics"] as const) test(`profile metricdb ${kind} applies authentication and backend query semantics`, async () => {
  const requests: URL[] = [];
  let partial = false;
  const server = Bun.serve({ port: 0, fetch: request => {
    const url = new URL(request.url); requests.push(url);
    expect(request.headers.get("authorization")).toBe(`Basic ${Buffer.from("doctor:secret").toString("base64")}`);
    expect(url.searchParams.get("query")).toBe("requests");
    expect(url.searchParams.get("latency_offset")).toBe(kind === "victoriametrics" ? "1ms" : null);
    expect(url.searchParams.get("nocache")).toBe(kind === "victoriametrics" ? "1" : null);
    return Response.json({status:"success",isPartial:partial,data:url.pathname.endsWith("query_range")
      ? {resultType:"matrix",result:[]} : {resultType:"vector",result:[]}});
  }});
  const context = new CommandContext({}, {name:"fixture",configPath:"",pluginConfig:{},value:{readonly:true,
    metricdb:{url:"http://unused.invalid",kind,username:"doctor",password:"secret"}}});
  try {
    const source = await perfMetricSource(context, server.url.toString());
    expect(source?.kind).toBe(kind);
    expect(requests).toHaveLength(0);
    await source!.query("requests", 123.456, context.signal);
    await source!.queryRange("requests", 120, 123.456, 0.5, context.signal);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.searchParams.get("time")).toBe("123.456");
    expect(Object.fromEntries(requests[1]!.searchParams)).toMatchObject({start:"120",end:"123.456",step:"0.5"});
    partial = true;
    expect((await source!.query("requests", 123.456, context.signal)).isPartial).toBe(true);
  } finally {await context.disposeClients();server.stop(true);}
});

test("profile accepts supported backend kinds and rejects legacy or invalid metric configuration", () => {
  const directory = mkdtempSync(join(tmpdir(), "doctor-metricdb-profile-"));
  const path = join(directory, "config.yaml");
  const read = (config: object) => {writeFileSync(path, JSON.stringify({profiles:{test:{readonly:true,...config}}})); return loadConfig(path);};
  try {
    for (const kind of [undefined, "prometheus", "victoriametrics"] as const) {
      expect(read({metricdb:{url:"http://metrics",kind}}).profiles.test!.metricdb?.kind).toBe(kind);
    }
    for (const kind of ["", "vm", "mysql", null, 1]) {
      expect(()=>read({metricdb:{url:"http://metrics",kind}})).toThrow("metricdb.kind");
    }
    expect(()=>read({prometheus:{url:"http://metrics"}})).toThrow("use metricdb");
  } finally {rmSync(directory, {recursive:true,force:true});}
});

test("scrape inspection uses the collector's credentials and preserves target evidence when config is forbidden", async () => {
  const auth: (string | null)[] = [];
  let targetsAvailable = true;
  const collector = Bun.serve({port: 0, fetch(request) {
    auth.push(request.headers.get("authorization"));
    if (!new URL(request.url).pathname.endsWith("/targets")) return new Response(null, {status: 403});
    if (!targetsAvailable) return new Response(null, {status: 404});
    const discoveredLabels = {__meta_kubernetes_namespace:"ns", __meta_kubernetes_service_name:"api-svc"};
    return Response.json({status:"success", data:{
      activeTargets: [{discoveredLabels, scrapePool:"pool", health:"down", scrapeInterval:"1m30s", scrapeUrl:"http://private"}],
      droppedTargets: [{discoveredLabels}],
    }});
  }});
  const context = new CommandContext({}, {name:"fixture",configPath:"",pluginConfig:{},value:{readonly:true,
    metricdb:{url:"http://unused.invalid",username:"query",password:"private",collector:{
      url:collector.url.toString(),username:"reader",password:"test",
    }}}});
  const service = {name:"api",workloads:[{name:"main",platform:"kubernetes",location:{kind:"service",name:"api-svc"}}]} as const;
  try {
    const scrape = await probePerfScrape(context, service, "ns");
    expect(scrape).toMatchObject({endpoint:"collector",configError:"HTTP 403 (permission_denied)",recommendedHoldSeconds:360,
      groups:[{state:"active",health:"down",intervalSeconds:90,intervalSource:"target"},{state:"dropped"}]});
    expect(scrapeAdvice(scrape!).join()).toContain("last error");
    targetsAvailable = false;
    const failed = await probePerfScrape(context, service, "ns");
    expect(failed).toMatchObject({targetsError:"HTTP 404 (resource_not_found)",groups:[]});
    expect(failed?.recommendedHoldSeconds).toBeUndefined();
    expect(scrapeAdvice(failed!).join()).not.toContain("未匹配到");
    expect(auth).toEqual(Array(4).fill("Basic " + Buffer.from("reader:test").toString("base64")));
  } finally {await context.disposeClients();collector.stop(true);}
});
