import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServiceCatalog, kubernetesServiceWorkload, withSummary,
  type CaseConsumeExtension, type CaseProduceExtension, type CaseBinding, type CaseProduceResult, type ServiceDefinition, type WorkloadInstance } from "@compforge/doctor-plugin";
import { HttpTransportError } from "../src/infra/http";
import { checkServiceCases, type CaseCheckActions } from "../src/overview/cases";
import { overviewProviders } from "../src/overview/extensions";
import { runOverviewSession } from "../src/overview/flow";
import { buildOverviewHtml } from "../src/overview/report";
import { CommandContext, CommandStatus, commandOutcome } from "../src/command";

const component = { name: "fixture", repository: { forge: { name: "test" }, path: "test" } };
const provider: CaseProduceExtension = { id: "files", kind: "case.produce", access: {},
  run: withSummary({ title: "Files", fields: [] }, async () => ({ cases: [] })) };
const bindings: CaseBinding[] = [
  { id: "kb-files", workload: "main", producer: { namespace: "plugin/test/service/kb", extension: "files" } },
];
const consumption: CaseConsumeExtension = { id: "downloads", kind: "case.consume", access: {},
  run: withSummary({ title: "Downloads", fields: [] }, async () => ({ bindings })) };
const consumer: ServiceDefinition = { name: "sandbox", component, workloads: [kubernetesServiceWorkload("sandbox")], extensions: [consumption] };
const kb: ServiceDefinition = { name: "kb", component, workloads: [], extensions: [provider] };
const plugin = { id: "test", version: "1", services: createServiceCatalog([consumer, kb]) };
const target: WorkloadInstance = { platform: "kubernetes", environment: "cluster", workload: "main", namespace: "ns", pod: "sandbox-1", uid: "uid-1", container: "app" };
const file: CaseProduceResult["cases"][number] = {
  case: { id: "download", desc: "File", input: { protocol: "http", method: "GET" }, judge: { e2e: { http: { status: [200] } } } },
  targets: [{ id: "primary", url: "https://files.test/download?signature=TOPSECRET", headers: { Authorization: "Bearer TOKEN" } }],
};
function fixture(overrides: Partial<CaseCheckActions> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "overview-cases-"));
  const controller = new AbortController();
  const calls: string[] = [];
  const actions: CaseCheckActions = {
    directory, signal: controller.signal, checkpoint: () => {}, approve: async () => ({ approved: true, source: "assume-yes" }),
    targets: async () => { calls.push("targets"); return { targets: [target] }; },
    sender: async selected => { calls.push(`sender:${selected.pod}`); return async request => {
      calls.push(request.url);
      return { statusCode: 200, statusText: "OK", headers: {}, body: new Response("file bytes").body };
    }; },
    consume: async (_service, extension, query) => { expect(query.tenantId).toBe("tenant"); calls.push("consume"); return { bindings }; },
    produce: async service => { expect(service.name).toBe("kb"); calls.push("provide"); return { cases: [file] }; },
    ...overrides,
  };
  return { directory, controller, calls, actions, run: () => checkServiceCases(plugin, consumer, [consumption], "tenant", actions),
    cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test("case-only Service is discoverable; provider is called after consumer preparation and URLs run from that target", async () => {
  const selected = overviewProviders(plugin, ["sandbox"]);
  expect(selected[0]!.consumers).toHaveLength(1);
  const f = fixture();
  try {
    const results = await f.run();
    expect(f.calls).toEqual(["consume", "targets", "sender:sandbox-1", "provide", file.targets[0]!.url]);
    expect(results[0]!.status).toBe("passed");
    expect(results[0]!.attempts[0]!.target).toEqual(target);
    expect(JSON.stringify(results)).not.toContain("TOPSECRET");
    expect(JSON.stringify(results)).not.toContain("Bearer TOKEN");
  } finally { f.cleanup(); }
});

test("DNS failure, alternate success and HTTP failure all remain attributable; subsequent Cases still run", async () => {
  const f = fixture({
    produce: async () => ({ cases: [{ ...file, targets: [...file.targets, { id: "internal", url: "http://platform:3000/download" }] }, { ...file, case: { ...file.case, id: "unauthorized" } }] }),
    sender: async () => async request => {
      if (request.url.startsWith("http://platform")) return { statusCode: 200, statusText: "OK", headers: {}, body: new Response("bytes").body };
      throw new HttpTransportError(`Could not resolve host ${request.url}, Bearer TOKEN`, { engine: "curl", exitCode: 6, timings: {}, error: `DNS ${request.url}` });
    },
  });
  try {
    const [result] = await f.run();
    expect(result!.status).toBe("failed");
    expect(result!.attempts.map(item => item.status)).toEqual(["failed", "passed", "failed"]);
    expect(result!.attempts[0]!.observation.response.transport?.exitCode).toBe(6);
    const files = readdirSync(f.directory, { recursive: true }).filter(file => typeof file === "string" && /\.(json|txt)$/.test(file)) as string[];
    const evidence = files.map(file => readFileSync(join(f.directory, file), "utf8")).join("\n");
    expect(evidence).not.toContain("TOPSECRET");
    expect(evidence).not.toContain("Bearer TOKEN");
  } finally { f.cleanup(); }
});

test("missing consumer tools and empty providers are coverage gaps, not network success", async () => {
  for (const overrides of [
    { sender: async () => { throw new Error("curl not found"); } },
    { produce: async () => ({ cases: [], reason: "No file in tenant" }) },
  ] satisfies Partial<CaseCheckActions>[]) {
    const f = fixture(overrides);
    try {
      const [result] = await f.run();
      expect(result!.attempts).toHaveLength(0);
      expect(result!.status).not.toBe("passed");
      expect(result!.error).toBeDefined();
      if (overrides.sender) expect(f.calls).not.toContain("provide");
    } finally { f.cleanup(); }
  }
});

test("Overview runs bindings automatically and retains history when checks fail", async () => {
  const f = fixture({ sender: async () => async () => ({ statusCode: 403, statusText: "Forbidden", headers: {}, body: new Response("denied").body }) });
  try {
    const selected = overviewProviders(plugin, ["sandbox"]);
    const result = await runOverviewSession(selected, { window: { from: "2026-01-01T00:00:00Z", to: "2026-01-01T01:00:00Z" }, maxEntries: 10 }, {
      summarize: async () => [], sample: async () => [], select: async () => undefined, collect: async () => commandOutcome(0),
      show: () => {}, cases: () => f.run(),
    });
    expect(result.collection).toBe("not-requested");
    expect(result.providers[0]!.cases![0]!.attempts[0]!.observation.response.statusCode).toBe(403);
    expect(buildOverviewHtml(result)).toContain("HTTP 403");
    expect(buildOverviewHtml(result)).not.toContain("TOPSECRET");
  } finally { f.cleanup(); }
});

test("cancellation retains the interrupted attempt and never starts a queued Case", async () => {
  const f = fixture({ produce: async () => ({ cases: [file, { ...file, case: { ...file.case, id: "second" } }] }) });
  f.actions.sender = async () => async () => {
    f.controller.abort();
    throw new Error("cancelled");
  };
  try {
    const [result] = await f.run();
    expect(result!.status).toBe("cancelled");
    expect(result!.attempts).toHaveLength(1);
  } finally { f.cleanup(); }
});


test("replica tool/provider failures preserve their identity and do not hide another replica", async () => {
  const f = fixture({
    targets: async () => ({ targets: [target, { ...target, pod: "sandbox-2" }, { ...target, pod: "sandbox-3" }] }),
  });
  let calls = 0;
  f.actions.sender = async instance => {
    if (instance.pod === target.pod) throw new Error("curl not found");
    return async () => ({ statusCode: 200, statusText: "OK", headers: {}, body: new Response("ok").body });
  };
  f.actions.produce = async () => {
    if (++calls === 1) throw new Error("presign unavailable");
    return { cases: [file] };
  };
  try {
    const [result] = await f.run();
    expect(result!.status).toBe("failed");
    expect(result!.error).toContain("sandbox-1/app: curl not found");
    expect(result!.error).toContain("sandbox-2/app provider: presign unavailable");
    expect(result!.attempts[0]!.target.pod).toBe("sandbox-3");
  } finally { f.cleanup(); }
});


test("real Case adapter executes only in consumer container and delivers failed HTTP evidence", async () => {
  const { caseCheckActions } = await import("../src/overview/case-runtime");
  const { writeOverviewEvidence } = await import("../src/overview/report");
  const { overviewCommand } = await import("../src/overview");
  const { finalizeResult, readReport } = await import("./report-fixture");
  const { readBundleText } = await import("./bundle-fixture");
  const f = fixture();
  const context = new CommandContext({}, undefined, { plugin });
  const calls: Array<{ target: unknown; command: string[] }> = [];
  const executor: import("@compforge/harness-toolbox/kubernetes/executor").Executor = {
    run: async command => {
      let stdout: string;
      if (command[0] === "auth") stdout = "yes";
      else if (command[0] === "config") stdout = "cluster\nhttps://kubernetes.test";
      else if (command[1] === "services") stdout = JSON.stringify({ metadata: { name: "sandbox" }, spec: { selector: { app: "sandbox" } } });
      else if (command[1] === "pods") stdout = JSON.stringify({ items: [{ metadata: { name: target.pod, uid: target.uid, namespace: "ns" }, spec: { containers: [{ name: "app" }] }, status: { phase: "Running" } }] });
      else throw new Error("Unexpected kubectl: " + command.join(" "));
      return { command, stdout, stderr: "", ok: true, exitCode: 0, durationMs: 1, timedOut: false };
    },
    exec: async (selected, command, options) => {
      calls.push({ target: selected, command });
      if (command[1] !== "--version") options?.onStdoutBytes?.(new TextEncoder().encode("HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\ndenied"));
      return { command, stdout: command[1] === "--version" ? "curl 8.0.0" : "", stderr: "", ok: true, exitCode: 0, durationMs: 1, timedOut: false };
    },
  };
  try {
    const actions = caseCheckActions(context, executor, { namespace: "ns" }, f.directory, () => {});
    // The real provider invocation uses its own bound Service and invocation context.
    const runtimeProvider: CaseProduceExtension = { ...provider, run: withSummary({ title: "Files", fields: [] }, async ctx => {
      expect(ctx.target.service.name).toBe("kb");
      return { cases: [file] };
    }) };
    const runtimeConsumption: CaseConsumeExtension = { ...consumption, run: withSummary({ title: "Relations", fields: [] }, async ctx => {
      expect(ctx.target.service.name).toBe("sandbox");
      return { bindings };
    }) };
    const runtimeConsumer = { ...consumer, extensions: [runtimeConsumption] };
    const runtimePlugin = { ...plugin, services: createServiceCatalog([runtimeConsumer, { ...kb, extensions: [runtimeProvider] }]) };
    const checks = await checkServiceCases(runtimePlugin, runtimeConsumer, [runtimeConsumption], undefined, actions);
    expect(checks[0]!.error).toBeUndefined();
    expect(checks[0]!.status).toBe("failed");
    expect(checks[0]!.attempts[0]!.target).toMatchObject({ namespace: "ns", pod: target.pod, uid: target.uid, container: "app" });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.target).toMatchObject({ pod: target.pod, container: "app" });
    expect(calls[1]!.command).toContain(file.targets[0]!.url);
    expect(calls[1]!.command).not.toContain("--insecure");
    expect(calls[1]!.command).not.toContain("--noproxy");
    const output = { query: { window: { from: "2026-01-01T00:00:00Z", to: "2026-01-01T01:00:00Z" }, maxEntries: 10 },
      providers: [{ namespace: "plugin/test/service/sandbox", name: "sandbox", facets: [], cases: checks }],
      sampleAllocations: [], samples: [], collection: "not-requested" as const };
    writeOverviewEvidence(output, context, f.directory);
    writeOverviewEvidence(output, context, f.directory);
    expect(context.artifacts.list()).toHaveLength(1);
    const path = join(f.directory, "delivery.html");
    await finalizeResult(context, overviewCommand, { status: CommandStatus.Failed, output, artifacts: context.artifacts.list() }, { output: path });
    const html = readReport(readFileSync(path, "utf8"));
    expect(html.index.sections[0]!.pages[0]!.status).toBe(CommandStatus.Failed);
    expect(html.pages).toContain("HTTP 403");
    expect(readBundleText(join(f.directory, "delivery.tar.gz"), "delivery/cases/sandbox/0/0/0/0/0/body.txt")).toBe("denied");
  } finally { await context.disposeClients(); f.cleanup(); }
});

test("consumer data is resolved at execution and invalid relationships never reach a Pod", async () => {
  for (const consume of [
    async () => { throw new Error("consumer configuration unavailable"); },
    async () => ({ bindings: [{ ...bindings[0]!, workload: "missing" }] }),
    async () => ({ bindings: [bindings[0]!, bindings[0]!] }),
  ]) {
    const f = fixture({ consume });
    try {
      const [result] = await f.run();
      expect(result!.status).toBe("unavailable");
      expect(result!.consumeExtension).toBe("downloads");
      expect(result!.error).toBeDefined();
      expect(f.calls).toEqual([]);
      expect(buildOverviewHtml({ query: { window: { from: "a", to: "b" }, maxEntries: 1 },
        providers: [{ namespace: "sandbox", name: "sandbox", facets: [], cases: [result!] }],
        collection: "not-requested", samples: [], sampleAllocations: [] })).toContain("downloads");
    } finally { f.cleanup(); }
  }
});

test("consume extensions isolate failures and preserve duplicate binding IDs across extensions", async () => {
  const f = fixture();
  const snapshots: import("../src/overview/cases").CaseCheckResult[] = [];
  f.actions.checkpoint = result => { if (!snapshots.includes(result)) snapshots.push(result); };
  f.actions.consume = async (_service, extension) => {
    if (extension.id === "broken") throw new Error("cannot read consumer config");
    return { bindings };
  };
  try {
    const results = await checkServiceCases(plugin, consumer,
      [{ ...consumption, id: "broken" }, consumption, { ...consumption, id: "second" }], "tenant", f.actions);
    expect(results.map(result => result.status)).toEqual(["unavailable", "passed", "passed"]);
    expect(results.map(result => result.consumeExtension)).toEqual(["broken", "downloads", "second"]);
    expect(snapshots).toHaveLength(3);
    expect(readdirSync(join(f.directory, "cases/sandbox"))).toEqual(["1", "2"]);
  } finally { f.cleanup(); }
});

test("empty consumption does not invoke producers; unsupported Case protocols never send requests", async () => {
  const empty = fixture({ consume: async () => ({ bindings: [] }) });
  try { expect(await empty.run()).toEqual([]); expect(empty.calls).toEqual([]); }
  finally { empty.cleanup(); }
  const unsupported = fixture({ produce: async () => ({ cases: [{ ...file, case: { ...file.case, input: { ...file.case.input, protocol: "tcp" } } } as never] }) });
  try {
    const [result] = await unsupported.run();
    expect(result!.status).toBe("failed");
    expect(result!.error).toContain("protocol");
    expect(result!.attempts).toHaveLength(0);
    expect(unsupported.calls).not.toContain(file.targets[0]!.url);
  } finally { unsupported.cleanup(); }
});


test("route credentials stay isolated while Case intent and resolved paths remain stable", async () => {
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  const sample = { ...file, case: { ...file.case, input: { ...file.case.input, path: "/health?probe=ready", headers: { Range: "bytes=0-1023" } } },
    targets: [file.targets[0]!, { id: "internal", url: "http://platform:3000/unused" }] };
  const f = fixture({ produce: async () => ({ cases: [sample] }), sender: async () => async request => {
    requests.push(request);
    return { statusCode: requests.length === 1 ? 503 : 200, statusText: "", headers: {}, body: new Response("ok").body };
  } });
  try {
    const [result] = await f.run();
    expect(requests.map(request => request.url)).toEqual(["https://files.test/health?probe=ready", "http://platform:3000/health?probe=ready"]);
    expect(requests[0]!.headers.authorization).toBe("Bearer TOKEN");
    expect(requests[1]!.headers.authorization).toBeUndefined();
    expect(requests.map(request => request.headers.range)).toEqual(["bytes=0-1023", "bytes=0-1023"]);
    expect(result!.attempts[0]!.caseHash).toBe(result!.attempts[1]!.caseHash);
    expect(result!.status).toBe("failed");
  } finally { f.cleanup(); }
});

test("HTTP 200 followed by an interrupted body remains a failed Case with transport evidence", async () => {
  const f = fixture({ sender: async () => async () => ({ statusCode: 200, statusText: "OK", headers: {},
    body: new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("download interrupted")); } }),
  }) });
  try {
    const [result] = await f.run();
    expect(result!.status).toBe("failed");
    expect(result!.attempts[0]!.observation.response.statusCode).toBe(200);
    expect(result!.attempts[0]!.observation.response.captureComplete).toBe(false);
    expect(result!.attempts[0]!.findings.some(finding => finding.kind === "http.transport-failed")).toBe(true);
  } finally { f.cleanup(); }
});

const hello: CaseProduceResult["cases"][number] = {
  case: { id: "hello", desc: "Send hello", input: { protocol: "http", method: "POST", body: '{"message":"hello"}' },
    judge: { e2e: { http: { status: [200], contentType: "text/event-stream" },
      sse: { eventField: "type", terminalEvent: "END", errorEvents: ["ERROR", "INPUT_REQUIRED"], requiredEvents: ["STREAM_MESSAGE"] } } } },
  targets: [{ id: "primary", url: "http://127.0.0.1:8015/chat", body: '{"message":"hello","session":"fresh-session"}' }],
};

test("non-read Cases are never sent when approval is denied; GET Cases remain automatic", async () => {
  let sent = 0;
  const f = fixture({ produce: async () => ({ cases: [hello] }),
    approve: async () => ({ approved: false, source: "non-interactive" }),
    sender: async () => async () => { sent++; throw new Error("must not send"); } });
  try {
    const [result] = await f.run();
    expect(result!.status).toBe("cancelled");
    expect(result!.error).toContain("非交互");
    expect(result!.attempts).toEqual([]);
    expect(sent).toBe(0);
  } finally { f.cleanup(); }
});

test("POST sends the runtime body once and keeps it out of the Case identity and report", async () => {
  let requests = 0;
  const f = fixture({ produce: async () => ({ cases: [hello] }), sender: async () => async request => {
    requests++;
    expect(request.method).toBe("POST");
    expect(new TextDecoder().decode(request.body)).toContain("fresh-session");
    return { statusCode: 200, statusText: "OK", headers: { "content-type": "text/event-stream" },
      body: new Response('data: {"type":"STREAM_MESSAGE","content":"Hello"}\n\ndata: {"type":"END"}\n\n').body };
  } });
  try {
    const [result] = await f.run();
    expect(result!.status).toBe("passed");
    expect(requests).toBe(1);
    expect(JSON.stringify(result)).not.toContain("fresh-session");
    expect(result!.attempts[0]!.sseCheck?.events.END).toBe(1);
  } finally { f.cleanup(); }
});

test("HTTP 200 cannot conceal SSE errors, interrupted inputs, empty output or missing END", async () => {
  for (const payload of [
    'data: {"type":"ERROR","error_code":"TLS_FAILURE","error_detail":"wrong version number"}\n\ndata: {"type":"END"}\n\n',
    'data: {"type":"INPUT_REQUIRED"}\n\n',
    'data: {"type":"END"}\n\n',
    'data: {"type":"STREAM_MESSAGE","content":"Hello"}\n\n',
    'data: {"type":"STREAM_MESSAGE"}\n\ndata: {"type":"END"}',
  ]) {
    const f = fixture({ produce: async () => ({ cases: [hello] }), sender: async () => async () => ({
      statusCode: 200, statusText: "OK", headers: { "content-type": "text/event-stream" }, body: new Response(payload).body,
    }) });
    try {
      const [result] = await f.run();
      expect(result!.status).toBe("failed");
      expect(result!.attempts[0]!.sseCheck!.errors.length).toBeGreaterThan(0);
      if (payload.includes("TLS_FAILURE")) expect(JSON.stringify(result)).toContain("wrong version number");
    } finally { f.cleanup(); }
  }
});

test("partial producer failure preserves a runnable network Case without claiming the message ran", async () => {
  const f = fixture({ produce: async () => ({ cases: [file], reason: "Message preparation: strategy unavailable" }) });
  try {
    const [result] = await f.run();
    expect(result!.attempts).toHaveLength(1);
    expect(result!.attempts[0]!.status).toBe("passed");
    expect(result!.status).toBe("failed");
    expect(result!.error).toContain("strategy unavailable");
  } finally { f.cleanup(); }
});

test("runtime body credentials are redacted from failed response evidence", async () => {
  const secretHello = { ...hello, targets: [{ ...hello.targets[0]!, body: '{"api_key":"BODY_SECRET","message":"hello"}' }] };
  const f = fixture({ produce: async () => ({ cases: [secretHello] }), sender: async () => async () => ({
    statusCode: 200, statusText: "OK", headers: { "content-type": "text/event-stream" },
    body: new Response('data: {"type":"ERROR","message":"BODY_SECRET rejected"}\n\n').body,
  }) });
  try {
    const [result] = await f.run();
    expect(JSON.stringify(result)).not.toContain("BODY_SECRET");
    expect(readFileSync(join(f.directory, result!.attempts[0]!.observation.response.bodyFile), "utf8")).not.toContain("BODY_SECRET");
  } finally { f.cleanup(); }
});
