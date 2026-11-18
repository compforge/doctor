import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/app/config/config";
import { CommandContext } from "../src/command";
import { perfMetricSource } from "../src/perf/observations";

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
