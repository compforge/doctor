import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/app/config/config";
import { CommandContext } from "../src/command";
import { openMetricDB, resolveMetricDBConfig } from "../src/datasource/metricdb";
import { probePerfScrape, scrapeAdvice } from "../src/perf/scrape";

test("MetricDB selection binds credentials, dialect and collector to the query endpoint", () => {
  const profile = { url: "https://metrics.example/select/1", kind: "victoriametrics" as const,
    username: "reader", password: "fixture", collector: { url: "https://collector.example" } };
  expect(resolveMetricDBConfig(profile)).toBe(profile);
  expect(resolveMetricDBConfig(profile, profile.url + "/")).toBe(profile);
  for (const url of ["https://other.example", "https://metrics.example/select/2"]) {
    expect(resolveMetricDBConfig(profile, url)).toEqual({ url });
  }
  expect(() => resolveMetricDBConfig(profile, " ")).toThrow("--prometheus");
});

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
    metricdb:{url:server.url.toString(),kind,username:"doctor",password:"secret"}}});
  try {
    const source = await openMetricDB(context, context.profile.value.metricdb!).reader.connectQuery(context.signal);
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
    expect(new URL(request.url).searchParams.get("state")).toBe("active");
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
  const client = openMetricDB(context, context.profile.value.metricdb!);
  try {
    const scrape = await probePerfScrape(context, service, "ns", client);
    expect(scrape).toMatchObject({endpoint:"collector",metricdbUrl:"http://unused.invalid",collectorUrl:collector.url.origin,
      configError:"HTTP 403 (permission_denied)",recommendedHoldSeconds:360,
      groups:[{state:"active",health:"down",intervalSeconds:90,intervalSource:"target"}]});
    expect(scrapeAdvice(scrape!).join()).toContain("last error");
    targetsAvailable = false;
    const failed = await probePerfScrape(context, service, "ns", client);
    expect(failed).toMatchObject({collectorUrl:collector.url.origin,targetsError:"HTTP 404 (resource_not_found)",groups:[]});
    expect(failed?.recommendedHoldSeconds).toBeUndefined();
    expect(scrapeAdvice(failed!).join()).not.toContain("未匹配到");
    expect(auth).toEqual(Array(4).fill("Basic " + Buffer.from("reader:test").toString("base64")));
  } finally {await context.disposeClients();collector.stop(true);}
});

test("scrape evidence excludes a collector URL rejected for embedded credentials", async () => {
  const context = new CommandContext({}, {name:"fixture",configPath:"",pluginConfig:{},value:{readonly:true,
    metricdb:{url:"http://metrics.invalid",collector:{url:"http://reader:fixture-secret@collector.invalid"}},
  }});
  try {
    const scrape = await probePerfScrape(context, {name:"chat",workloads:[]}, "app", openMetricDB(context, context.profile.value.metricdb!));
    expect(scrape).toMatchObject({metricdbUrl:"http://metrics.invalid",endpoint:"collector",
      configError:"invalid_argument",targetsError:"invalid_argument"});
    expect(scrape?.collectorUrl).toBeUndefined();
    expect(JSON.stringify(scrape)).not.toContain("fixture-secret");
  } finally { await context.disposeClients(); }
});

test("vmselect fallback verifies the writer, tenant and active service, and leaves ambiguous instances as hints", async () => {
  const directory = mkdtempSync(join(tmpdir(), "doctor-vmoperator-"));
  const kubeconfig = join(directory, "kubeconfig");
  const states: string[] = [];
  let ambiguous = false, matches = true, forbidden = false, helm = false;
  const query = Bun.serve({port:0, hostname:"127.0.0.1", fetch(req) {
    const url = new URL(req.url);
    expect(req.headers.get("authorization")).toBe("Basic " + Buffer.from("query:private").toString("base64"));
    if (url.pathname.endsWith("/query")) {
      expect(url.searchParams.get("query")).toContain("vmagent_remotewrite_bytes_sent_total");
      return Response.json({status:"success",data:{resultType:"vector",result:[{metric:{instance:"metrics-only"},value:[0,"1"]}]}});
    }
    return new Response(null, {status:400});
  }});
  const yaml = () => helm ? "remote_write:\n  - url: http://vminsert.monitor.svc:8480/insert/4/prometheus\nscrape_configs: []" : "scrape_configs: []";
  const targets = () => JSON.stringify({status:"success",data:{activeTargets:helm ? ["api","worker"].map(component => ({
    discoveredLabels:{__meta_kubernetes_namespace:"app",__meta_kubernetes_pod_name:"chat-"+component,
      __meta_kubernetes_pod_label_app:"chat",__meta_kubernetes_pod_label_component:component},
    scrapePool:"pod-job",health:"up",scrapeInterval:"15s",scrapeUrl:`http://chat-${component}/metrics`,
  })) : [{
    labels:{namespace:matches ? "app" : "other",service:"chat"},health:"up",scrapeInterval:"15s",scrapeUrl:"http://chat/metrics",
  }]}}, null, 2);
  const agent = Bun.serve({port:0, hostname:"127.0.0.1", fetch(req) {
    expect(req.headers.get("authorization")).toBeNull();
    const url = new URL(req.url);
    if (url.pathname.endsWith("/targets")) {
      states.push(url.searchParams.get("state") ?? "");
      return new Response(targets());
    }
    expect(url.pathname).toBe("/api/v1/status/config");
    return Response.json({status:"success",data:{yaml:yaml()}});
  }});
  const version = "operator.victoriametrics.com/v1beta1";
  function service(name: string, kind: string, uid: string, port: number) {
    return {metadata:{name,namespace:"monitor",ownerReferences:[{apiVersion:version,kind,uid,controller:true}]},
      spec:{clusterIP:"127.0.0.1",ports:[{name:"http",port}]}};
  }
  const agents = [
    ["writer","vminsert-vm.monitor.svc","4"], ["wrong-tenant","vminsert-vm.monitor.svc","5"],
    ["wrong-cluster","vminsert-other.monitor.svc","4"],
  ];
  const api = Bun.serve({port:0, hostname:"127.0.0.1", fetch(req) {
    const url = new URL(req.url);
    if (forbidden) return new Response(null,{status:403});
    if (helm) {
      if (url.searchParams.has("labelSelector")) return Response.json({items:[]});
      if (url.pathname.endsWith("/services/chat")) return Response.json({metadata:{name:"chat",namespace:"app"},
        spec:{selector:{app:"chat",component:"api"}}});
      const roles = ["vmselect","vminsert"];
      if (url.pathname.endsWith("/deployments")) return Response.json({items:roles.map((app, i) => ({
        spec:{template:{metadata:{labels:{app}},spec:{containers:[{args:[`-storageNode=storage:${8401-i}`]}]}}},
      }))});
      return Response.json({items:[
        ...roles.map((app, i) => ({metadata:{name:app,namespace:"monitor",labels:{app}},
          spec:{clusterIP:"127.0.0.1",ports:[{name:"http",port:i ? 8480 : query.port}],selector:{app}}})),
        {metadata:{name:"prometheus",namespace:"monitor",labels:{"app.kubernetes.io/name":"prometheus",
          "app.kubernetes.io/component":"server"}},spec:{clusterIP:"127.0.0.1",ports:[{name:"http",port:agent.port}]}},
      ]});
    }
    const writers = ambiguous ? [...agents,["second","vminsert-vm.monitor.svc","4"]] : agents;
    if (url.pathname.endsWith("/vmagents")) return Response.json({items:writers.map(([name,host,tenant]) => ({
      metadata:{name,namespace:"monitor",uid:name}, spec:{remoteWrite:[{url:`http://${host}:8480/insert/${tenant}/prometheus/api/v1/write`}]},
    }))});
    const role = url.searchParams.get("labelSelector");
    if (role?.endsWith("=vmselect")) return Response.json({items:[service("vmselect-vm","VMCluster","cluster",query.port!)]});
    if (role?.endsWith("=vminsert")) return Response.json({items:[
      service("vminsert-vm","VMCluster","cluster",8480),service("vminsert-other","VMCluster","other-cluster",8480),
    ]});
    return Response.json({items:writers.map(([name]) => service("vmagent-"+name,"VMAgent",name!,agent.port!))});
  }});
  writeFileSync(kubeconfig,JSON.stringify({apiVersion:"v1",kind:"Config","current-context":"test",
    clusters:[{name:"k",cluster:{server:api.url.origin}}],contexts:[{name:"test",context:{cluster:"k",user:"user"}}],
    users:[{name:"user",user:{token:"test"}}]}));
  const context = new CommandContext({}, {name:"test",configPath:"",pluginConfig:{},value:{readonly:true,
    metricdb:{url:query.url.origin + "/select/4/prometheus",username:"query",password:"private"}}});
  const client = openMetricDB(context, context.profile.value.metricdb!);
  const raw: import("../src/perf/scrape").RawScrape = {};
  const inspect = () => probePerfScrape(context,{name:"chat",workloads:[]}, "app",client,raw,{kubeconfig});
  try {
    const metricdbUrl = query.url.origin + "/select/4/prometheus";
    expect(await inspect()).toMatchObject({endpoint:"collector",metricdbUrl,collectorUrl:agent.url.origin,
      discoveredCollector:"monitor/vmagent-writer",recommendedHoldSeconds:60});
    expect(new TextDecoder().decode(raw.targets)).toBe(targets());
    expect(raw.configYaml).toBe("scrape_configs: []");
    ambiguous = true;
    const multiple = await inspect();
    expect(multiple).toMatchObject({endpoint:"metricdb",metricdbUrl,collectorUrl:metricdbUrl});
    expect(multiple?.discoveryIssue).toContain("monitor/vmagent-second");
    expect(multiple?.vmagentInstances).toEqual(["metrics-only"]);
    expect(states).toEqual(["active"]);
    ambiguous = false; matches = false;
    expect((await inspect())?.discoveredCollector).toBeUndefined();
    forbidden = true;
    const denied = await inspect();
    expect(denied?.discoveryIssue).toContain("403");
    expect(denied?.vmagentInstances).toEqual(["metrics-only"]);
    expect(states).toEqual(["active","active"]);

    // @case A Helm VM cluster receives Prometheus remote_write and discovers application Pods without Service labels.
    forbidden = false; helm = true;
    expect(await inspect()).toMatchObject({endpoint:"collector",metricdbUrl,collectorUrl:agent.url.origin,
      discoveredCollector:"monitor/prometheus",recommendedHoldSeconds:60,
      groups:[{pool:"pod-job",intervalSeconds:15,count:1}]});
    expect(raw.configYaml).toBe(yaml());
    expect(new TextDecoder().decode(raw.targets)).toBe(targets());
    expect(states).toEqual(["active","active","active"]);
  } finally {
    await context.disposeClients();
    agent.stop(true); query.stop(true); api.stop(true); rmSync(directory,{recursive:true,force:true});
  }
});
