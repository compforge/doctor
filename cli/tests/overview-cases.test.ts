import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServiceCatalog, kubernetesServiceWorkload, withSummary,
  type HttpCaseProviderExtension, type CaseBinding, type ProvidedHttpCase, type ServiceDefinition, type WorkloadInstance } from "@compforge/doctor-plugin";
import { HttpTransportError } from "../src/infra/http";
import { checkServiceCases, serviceCaseBindings, type CaseCheckActions } from "../src/overview/cases";
import { overviewProviders } from "../src/overview/extensions";
import { runOverviewSession } from "../src/overview/flow";
import { buildOverviewHtml } from "../src/overview/report";
import { CommandContext, CommandStatus, commandOutcome } from "../src/command";

const component = { name: "fixture", repository: { forge: { name: "test" }, path: "test" } };
const provider: HttpCaseProviderExtension = { id: "files", kind: "case.http.provide", access: {},
  run: withSummary({ title: "Files", fields: [] }, async () => ({ cases: [] })) };
const bindings: CaseBinding[] = [
  { id: "kb-files", workload: "main", provider: { namespace: "plugin/test/service/kb", extension: "files" } },
];
const consumer: ServiceDefinition = { name: "sandbox", component, workloads: [kubernetesServiceWorkload("sandbox")], caseBindings: bindings };
const kb: ServiceDefinition = { name: "kb", component, workloads: [], extensions: [provider] };
const plugin = { id: "test", version: "1", services: createServiceCatalog([consumer, kb]) };
const target: WorkloadInstance = { platform: "kubernetes", environment: "cluster", workload: "main", namespace: "ns", pod: "sandbox-1", uid: "uid-1", container: "app" };
const file: ProvidedHttpCase = { id: "download", description: "File", request: { url: "https://files.test/download?signature=TOPSECRET", headers: { Authorization: "Bearer TOKEN" } }, expect: { status: [200] } };
function fixture(overrides: Partial<CaseCheckActions> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "overview-cases-"));
  const controller = new AbortController();
  const calls: string[] = [];
  const actions: CaseCheckActions = {
    directory, signal: controller.signal, checkpoint: () => {},
    targets: async () => { calls.push("targets"); return { targets: [target] }; },
    sender: async selected => { calls.push(`sender:${selected.pod}`); return async request => {
      calls.push(request.url);
      return { statusCode: 200, statusText: "OK", headers: {}, body: new Response("file bytes").body };
    }; },
    provide: async service => { expect(service.name).toBe("kb"); calls.push("provide"); return { cases: [file] }; },
    ...overrides,
  };
  return { directory, controller, calls, actions, run: () => checkServiceCases(plugin, consumer, serviceCaseBindings(consumer), "tenant", actions),
    cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test("case-only Service is discoverable; provider is called after consumer preparation and URLs run from that target", async () => {
  const selected = overviewProviders(plugin, ["sandbox"]);
  expect(selected[0]!.bindings).toHaveLength(1);
  const f = fixture();
  try {
    const results = await f.run();
    expect(f.calls).toEqual(["targets", "sender:sandbox-1", "provide", file.request.url]);
    expect(results[0]!.status).toBe("passed");
    expect(results[0]!.attempts[0]!.target).toEqual(target);
    expect(JSON.stringify(results)).not.toContain("TOPSECRET");
    expect(JSON.stringify(results)).not.toContain("Bearer TOKEN");
  } finally { f.cleanup(); }
});

test("DNS failure, alternate success and HTTP failure all remain attributable; subsequent Cases still run", async () => {
  const f = fixture({
    provide: async () => ({ cases: [{ ...file, alternatives: [{ id: "internal", url: "http://platform:3000/download" }] }, { ...file, id: "unauthorized" }] }),
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
    { provide: async () => ({ cases: [], reason: "No file in tenant" }) },
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
  const f = fixture({ provide: async () => ({ cases: [file, { ...file, id: "second" }] }) });
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
  f.actions.provide = async () => {
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
    const runtimeProvider: HttpCaseProviderExtension = { ...provider, run: withSummary({ title: "Files", fields: [] }, async ctx => {
      expect(ctx.target.service.name).toBe("kb");
      return { cases: [file] };
    }) };
    const runtimePlugin = { ...plugin, services: createServiceCatalog([consumer, { ...kb, extensions: [runtimeProvider] }]) };
    const checks = await checkServiceCases(runtimePlugin, consumer, bindings, undefined, actions);
    expect(checks[0]!.error).toBeUndefined();
    expect(checks[0]!.status).toBe("failed");
    expect(checks[0]!.attempts[0]!.target).toMatchObject({ namespace: "ns", pod: target.pod, uid: target.uid, container: "app" });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.target).toMatchObject({ pod: target.pod, container: "app" });
    expect(calls[1]!.command).toContain(file.request.url);
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
    expect(readBundleText(join(f.directory, "delivery.tar.gz"), "delivery/cases/sandbox/0/0/0/0/body.txt")).toBe("denied");
  } finally { await context.disposeClients(); f.cleanup(); }
});
