import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { allLogWorkloads, createServiceCatalog, type CollectWindow, type Fact } from "@compforge/doctor-plugin";
import { KubectlExecutor } from "@compforge/harness-toolbox/kubernetes/executor";
import { ClientNodePodLogAccess } from "@compforge/harness-toolbox/kubernetes/client-node-pod-log";
import { parsePods } from "@compforge/harness-toolbox/kubernetes/pod";
import type { PodLogRequest } from "@compforge/harness-toolbox/kubernetes/pod-log";
import { inspectExtension, traceExtension } from "../../packages/plugin/tests/extension-fixture";
import { CommandContext, CommandStatus } from "../src/command";
import { createCollectCommand } from "../src/collect/composite";
import { logCommand } from "../src/collect/log/command";
import { selectLogTimeWindow } from "../src/collect/log/window";
import type { DataLogWindow } from "../src/collect/log/data-window";
import { logService, podDiscoveryExecutor } from "./log-fixture";

const from = "2026-11-04T09:00:00Z", to = "2026-11-04T09:01:00Z";
const identity = { kind: "run_id", value: "biz-a" };
const input = { id: "biz-a", traceIds: [] as string[], now: new Date("2026-11-04T10:00:00Z") };
function contribution(window: Partial<CollectWindow> = {}, factIndex = 0): DataLogWindow {
  return { bizId: "biz-a", service: "api", queryId: "query", factIndex, window: { identity, from, to, ...window } };
}
function select(windows: DataLogWindow[], overrides: Partial<Parameters<typeof selectLogTimeWindow>[0]> = {}) {
  return selectLogTimeWindow({ ...input, dataWindows: { windows, rejected: [] }, ...overrides });
}

test("each window is padded before union; CLI, contribution, profile and default keep their provenance", () => {
  const windows = [contribution({ timePadding: "30s" }), contribution({ from: "2026-11-04T09:02:00Z", to: "2026-11-04T09:03:00Z", timePadding: "5m" }, 1)];
  const result = select(windows, { profileTimePadding: "1m" });
  expect(result).toMatchObject({ source: "data", sinceTime: "2026-11-04T08:57:00.000Z", untilTime: "2026-11-04T09:08:00.000Z" });
  expect(result.windows.map(window => [window.timePadding, window.paddingSource])).toEqual([["30s", "contribution"], ["5m", "contribution"]]);
  const cli = select(windows, { timePadding: "10s", profileTimePadding: "1m" });
  expect(cli).toMatchObject({ sinceTime: "2026-11-04T08:59:50.000Z", untilTime: "2026-11-04T09:03:10.000Z" });
  expect(cli.windows.every(window => window.paddingSource === "cli")).toBe(true);
  expect(select([contribution()], { profileTimePadding: "1m" }).windows[0]).toMatchObject({ timePadding: "1m", paddingSource: "profile" });
  expect(select([contribution()]).windows[0]).toMatchObject({ timePadding: "10m", paddingSource: "default" });
});

test("single bounds use complete trace, frozen collection start or lookback anchored at the contributed end", () => {
  const trace = { traceIds: ["t"], traceWindows: [{ bizId: "biz-a", traceId: "t", startMs: Date.parse(from), endMs: Date.parse(to) }] };
  expect(select([contribution({ to: undefined })], trace).windows[0]).toMatchObject({ from, to: "2026-11-04T09:01:00.000Z", toSource: "trace" });
  expect(select([contribution({ from: undefined })], trace).windows[0]).toMatchObject({ from: "2026-11-04T09:00:00.000Z", to, fromSource: "trace" });
  expect(select([contribution({ to: undefined })]).windows[0]).toMatchObject({ to: input.now.toISOString(), toSource: "collection-start" });
  expect(select([contribution({ from: undefined })]).windows[0]).toMatchObject({ from: "2026-11-04T03:01:00.000Z", fromSource: "lookback" });
});

test("explicit ranges bypass automatic bounds and padding; unrelated IDs cannot supply windows", () => {
  expect(select([contribution({ timePadding: "1h" })], { sinceTime: from, untilTime: to })).toMatchObject({ source: "explicit", sinceTime: from, untilTime: to, windows: [] });
  expect(select([contribution({ identity: { kind: "run_id", value: "related-other" } })])).toMatchObject({ source: "default", since: "6h" });
  expect(select([{ ...contribution(), bizId: "other" }])).toMatchObject({ source: "default", since: "6h" });
  expect(() => select([contribution()], { timePadding: "bad", profileTimePadding: "1m" })).toThrow("time-padding");
});

test("conflicting completed bounds are reported and fall back to trace; overflow cannot reach transport", () => {
  const trace = { traceIds: ["t"], traceWindows: [{ bizId: "biz-a", traceId: "t", startMs: Date.parse(from), endMs: Date.parse(to) }] };
  const result = select([contribution({ from: "2026-11-04T11:00:00Z", to: undefined })], trace);
  expect(result.source).toBe("trace");
  expect(result.rejected[0]).toMatchObject({ queryId: "query", factIndex: 0, reason: expect.stringContaining("冲突") });
  const overflow = select([contribution({ timePadding: "2400000000h" })]);
  expect(overflow.source).toBe("default");
  expect(overflow.rejected).toHaveLength(1);
});

/** @case Real Inspect facts reach Pod Log requests and archived provenance through both standalone log and composed collect. */
for (const variant of ["standalone", "composite", "invalid", "explicit", "trace-only"] as const) test(`Data window ${variant} reaches transport and evidence`, async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-data-window-"));
  const kubeconfig = join(root, "kubeconfig");
  writeFileSync(kubeconfig, "apiVersion: v1\nkind: Config\nclusters: []\ncontexts: []\nusers: []\n");
  const ok = { ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false, command: [] };
  let inspectCalls = 0;
  const plugin = { id: "window-fixture", version: "1", services: createServiceCatalog([{ ...logService(),
    logs: { ...(variant !== "trace-only" ? { identityRelations: { biz_id: ["run_id"] } } : {}) },
    extensions: [allLogWorkloads(), inspectExtension({ access: {}, accepts: ["biz_id"], expands: ["run_id"], provides: ["reference", "collect.window"],
      inspect: async (_context, queries) => { inspectCalls++; return queries.map(({ identity: query }) => ({ identity: query, status: "collected" as const, result: {
        resolution: { inputId: query.value, resolvedAs: "run_id", identifiers: {} }, facts: [
          { factType: "relation", kind: "reference", schemaVersion: 1, from: query, to: identity },
          ...(variant !== "composite" || inspectCalls === 1 ? [{ factType: "record" as const, kind: "collect.window", schemaVersion: 1, recordKey: "run", record: { identity, from: variant === "invalid" ? "bad" : from, to, timePadding: "30s" } }] : []),
          { factType: "record", kind: "collect.window", schemaVersion: 1, recordKey: "unrelated", record: { identity: { kind: "run_id", value: "unrelated" }, from: "2020-01-01T00:00:00Z", to } },
        ] satisfies Fact[],
      } })); },
    }), ...(variant === "trace-only" ? [traceExtension({ access: {}, endpoint: { host: "unused", port: 80 },
      resolve: async () => ({ traceId: "trace-a", resolvedAs: "trace_id" }) })] : [])],
  }]) };
  const context = new CommandContext({ kubernetes: { kubeconfig: { kubeconfig, source: "flag" }, channel: { available: true, client: ok } } }, {
    name: "test", configPath: "", value: { readonly: true, namespace: "test", kube: { kubeconfig_path: kubeconfig }, log: { timePadding: "5m" } }, pluginConfig: {},
  }, { plugin });
  const pods = parsePods(JSON.stringify({ items: [{ metadata: { name: "pod-1", uid: "uid" }, spec: { containers: [{ name: "app" }] },
    status: { phase: "Running", containerStatuses: [{ name: "app", containerID: "current", restartCount: 0 }] } }] }), "test");
  const discovery = podDiscoveryExecutor(pods);
  const ensure = spyOn(context, "ensureEnvironment").mockResolvedValue(undefined);
  const exec = spyOn(KubectlExecutor.prototype, "run").mockImplementation(args => args[0] === "auth" ? Promise.resolve({ ...ok, stdout: "yes\n" }) : discovery.run(args));
  const version = spyOn(ClientNodePodLogAccess.prototype, "clientVersion").mockResolvedValue(ok);
  const requests: PodLogRequest[] = [];
  const logs = spyOn(ClientNodePodLogAccess.prototype, "collectPodLogs").mockImplementation(async request => {
    requests.push(request); request.onLine?.("2026-11-04T09:00:34Z INFO biz-a trace-a");
    return { ...ok, captureStatus: "complete", bytesRead: 50, attempts: 1 };
  });
  const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
  let artifacts: readonly import("../src/command").CommandArtifact[] = [];
  try {
    const options = { bizIds: ["biz-a"], services: ["api"], ...(variant === "explicit" ? { sinceTime: from, untilTime: to, timePadding: "1h" } : {}) };
    const result = variant === "composite"
      ? await createCollectCommand().run(context, { ...options, kinds: ["data", "log"] })
      : await logCommand.run(context, options);
    expect(result.status).toBe(CommandStatus.Ok);
    expect(requests).toHaveLength(1);
    if (variant === "invalid") expect(requests[0]!.since).toBe("6h");
    else expect(requests[0]).toMatchObject({ sinceTime: variant === "explicit" ? from : "2026-11-04T08:59:30.000Z",
      untilTime: variant === "explicit" ? to : "2026-11-04T09:01:30.000Z" });
    artifacts = result.output && "steps" in result.output ? result.output.steps.flatMap(step => step.result.artifacts) : result.artifacts;
    const savedFiles = artifacts.filter(artifact => artifact.command === "log").map(artifact => join(artifact.path, "collection.json"));
    const saved = (await Promise.all(savedFiles.filter(path => Bun.file(path).size > 0).map(path => Bun.file(path).json()))).find(item => item.params?.window);
    expect(saved).toBeDefined();
    expect(saved.params.window.source).toBe(variant === "invalid" ? "default" : variant === "explicit" ? "explicit" : "data");
    if (variant === "invalid") {
      expect(saved.params.window.rejected[0]).toMatchObject({ service: "api", factIndex: 1 });
      expect(stdout.mock.calls.map(([line]) => String(line)).join("")).toContain("忽略窗口");
    } else if (variant !== "explicit") {
      expect(saved.params.window.windows[0]).toMatchObject({ paddingSource: "contribution", timePadding: "30s", contribution: { service: "api", factIndex: 1, window: { identity, from, to } } });
    }
    expect(saved.params.since_time).toBe(requests[0]!.sinceTime);
    expect(saved.params.until_time).toBe(requests[0]!.untilTime);
  } finally {
    for (const mock of [ensure, exec, version, logs, stdout, stderr]) mock.mockRestore();
    await context.disposeClients();
    for (const artifact of artifacts) rmSync(dirname(artifact.path), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
