import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CommandContext, CommandStatus } from "../src/command";
import { createCollectCommand } from "../src/collect/composite";
import { traceCommand } from "../src/collect/trace/command";
import { logCommand } from "../src/collect/log/command";
import { timePaddingMs, selectLogTimeWindow, traceLogWindows } from "../src/collect/log/window";
import { createServiceCatalog } from "@compforge/doctor-plugin";
import { KubectlExecutor } from "@compforge/harness-toolbox/kubernetes/executor";
import { ClientNodePodLogAccess } from "@compforge/harness-toolbox/kubernetes/client-node-pod-log";
import { parsePods } from "@compforge/harness-toolbox/kubernetes/pod";
import type { PodLogRequest } from "@compforge/harness-toolbox/kubernetes/pod-log";
import { traceExtension } from "../../packages/plugin/tests/extension-fixture";
import { logService, podDiscoveryExecutor, logPlugin } from "./log-fixture";

function snapshot(traceId: string, startMs: number, complete = true) {
  const path = mkdtempSync(join(tmpdir(), "doctor-log-window-"));
  writeFileSync(join(path, "analysis.json"), JSON.stringify({
    kind: "doctor.trace", schema_version: 2, trace_id: traceId,
    collection: { scope: "trace", complete }, nodes: [],
    spans: [{ start_ms: startMs, dur_ms: 1000 }, { start_ms: startMs + 500, dur_ms: 2000 }],
    measurements: { nodes: {}, trace: [] }, views: { default: {} },
  }));
  return { id: traceId, command: "trace", path };
}
const start = Date.parse("2026-11-04T09:08:33.963Z");

/** @case A historical trace selects its actual interval, including the latest span end, independent of today's six-hour default. */
test("complete trace spans define a padded window and survive collect delegation", async () => {
  const artifact = snapshot("trace-a", start);
  const context = new CommandContext({}, undefined, { plugin: logPlugin() });
  const trace = spyOn(traceCommand, "run").mockResolvedValue({ status: CommandStatus.Ok, artifacts: [artifact],
    output: { items: [{ bizId: "biz-a", traceIds: ["trace-a"], artifacts: [artifact], status: CommandStatus.Ok }] } });
  const log = spyOn(logCommand, "run").mockResolvedValue({ status: CommandStatus.Ok, artifacts: [], output: { namespace: "test", services: [], items: [] } });
  try {
    const result = await createCollectCommand().run(context, { bizIds: ["biz-a"], kinds: ["trace", "log"] });
    expect(result.status).toBe(CommandStatus.Ok);
    expect(trace).toHaveBeenCalledTimes(1);
    const windows = log.mock.calls[0]![1].traceWindows;
    expect(windows).toEqual([{ bizId: "biz-a", traceId: "trace-a", startMs: start, endMs: start + 2500 }]);
    expect(selectLogTimeWindow({ id: "biz-a", traceIds: ["trace-a"], traceWindows: windows })).toMatchObject({
      source: "trace", sinceTime: "2026-11-04T08:58:33.963Z", untilTime: "2026-11-04T09:18:36.463Z",
    });
  } finally {
    trace.mockRestore(); log.mockRestore(); await context.disposeClients();
    for (const item of context.artifacts.list()) rmSync(item.path, { recursive: true, force: true });
  }
});

test("every resolved trace must be covered; unrelated business windows cannot narrow a query", () => {
  const windows = [
    { bizId: "biz-a", traceId: "trace-a", startMs: start, endMs: start + 2500 },
    { bizId: "biz-a", traceId: "trace-b", startMs: start + 10_000, endMs: start + 11_000 },
  ];
  const input = { id: "biz-a", traceIds: ["trace-a", "trace-b"], traceWindows: windows };
  expect(selectLogTimeWindow(input)).toMatchObject({ source: "trace", sinceTime: "2026-11-04T08:58:33.963Z", untilTime: "2026-11-04T09:18:44.963Z" });
  expect(selectLogTimeWindow({ ...input, traceIds: ["trace-a", "missing"] })).toMatchObject({ source: "default", since: "6h" });
  expect(selectLogTimeWindow({ ...input, id: "other" })).toMatchObject({ source: "default", since: "6h" });
  expect(selectLogTimeWindow({ id: "old-biz", traceIds: [] })).toMatchObject({ source: "default", since: "6h" });
});

test("explicit time arguments preserve existing semantics instead of using trace bounds", () => {
  const input = { id: "biz-a", traceIds: ["trace-a"], traceWindows: [{ bizId: "biz-a", traceId: "trace-a", startMs: start, endMs: start + 2500 }] };
  expect(selectLogTimeWindow({ ...input, since: "10m" })).toMatchObject({ source: "explicit", since: "10m", untilTime: undefined });
  expect(selectLogTimeWindow({ ...input, sinceTime: "2026-11-04T00:00:00Z", untilTime: "2026-11-04T23:00:00Z" })).toMatchObject({ source: "explicit", sinceTime: "2026-11-04T00:00:00Z", untilTime: "2026-11-04T23:00:00Z" });
  expect(selectLogTimeWindow({ ...input, untilTime: "2026-11-05T01:00:00Z" })).toMatchObject({ source: "explicit", sinceTime: "2026-11-04T19:00:00.000Z", untilTime: "2026-11-05T01:00:00Z" });
});

test("partial, single-span, empty and invalid timestamps never narrow the default window", () => {
  const artifact = snapshot("trace-a", start, false);
  const output = { items: [{ bizId: "biz-a", traceIds: ["trace-a"], artifacts: [artifact], status: CommandStatus.Partial }] };
  try {
    expect(traceLogWindows(output)).toEqual([]);
    for (const overrides of [
      { collection: { scope: "span", complete: true } },
      { spans: [] },
      { spans: [{ start_ms: null, dur_ms: 1 }] },
      { spans: [{ start_ms: start, dur_ms: -1 }] },
    ]) {
      writeFileSync(join(artifact.path, "analysis.json"), JSON.stringify({ kind: "doctor.trace", schema_version: 2, trace_id: "trace-a",
        collection: { scope: "trace", complete: true }, spans: [{ start_ms: start, dur_ms: 1 }],
        nodes: [], measurements: { nodes: {}, trace: [] }, views: { default: {} }, ...overrides }));
      expect(traceLogWindows(output)).toEqual([]);
    }
  } finally { rmSync(artifact.path, { recursive: true, force: true }); }
});


test("padding accepts duration overrides and rejects invalid values before collection", () => {
  expect(timePaddingMs()).toBe(600_000);
  expect(timePaddingMs("30s")).toBe(30_000);
  const traceWindows = [{ bizId: "a", traceId: "t", startMs: start, endMs: start + 2500 }];
  expect(selectLogTimeWindow({ id: "a", traceIds: ["t"], traceWindows, timePadding: "30s" })).toMatchObject({
    source: "trace", sinceTime: "2026-11-04T09:08:03.963Z", untilTime: "2026-11-04T09:09:06.463Z",
  });
  for (const value of ["", "bad", "-1m", "0s"]) expect(() => timePaddingMs(value)).toThrow("time-padding");
});


/** @case CLI beats profile, profile beats default, and the chosen interval reaches the actual Pod Log request and saved evidence. */
for (const variant of ["default", "profile", "cli"] as const) test(`log timePadding ${variant} reaches the transport`, async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-padding-request-"));
  const kubeconfig = join(root, "kubeconfig");
  writeFileSync(kubeconfig, "apiVersion: v1\nkind: Config\nclusters: []\ncontexts: []\nusers: []\n");
  const ok = { ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false, command: [] };
  const context = new CommandContext({ kubernetes: { kubeconfig: { kubeconfig, source: "flag" }, channel: { available: true, client: ok } } }, {
    name: "test", configPath: "", value: { readonly: true, namespace: "test", kube: { kubeconfig_path: kubeconfig },
      ...(variant !== "default" ? { log: { timePadding: "5m" } } : {}) }, pluginConfig: {},
  }, { plugin: { id: "padding-fixture", version: "1", services: createServiceCatalog([{ ...logService(),
    extensions: [traceExtension({ access: {}, endpoint: { host: "unused", port: 80 },
      resolve: async () => ({ traceId: "trace-a", resolvedAs: "trace_id" }) })],
  }]) } });
  const pods = parsePods(JSON.stringify({ items: [{ metadata: { name: "pod-1", uid: "uid" }, spec: { containers: [{ name: "app" }] },
    status: { phase: "Running", containerStatuses: [{ name: "app", containerID: "current", restartCount: 0 }] } }] }), "test");
  const discovery = podDiscoveryExecutor(pods);
  const ensure = spyOn(context, "ensureEnvironment").mockResolvedValue(undefined);
  const exec = spyOn(KubectlExecutor.prototype, "run").mockImplementation(args => args[0] === "auth" ? Promise.resolve({ ...ok, stdout: "yes\n" }) : discovery.run(args));
  const version = spyOn(ClientNodePodLogAccess.prototype, "clientVersion").mockResolvedValue(ok);
  const requests: PodLogRequest[] = [];
  const logs = spyOn(ClientNodePodLogAccess.prototype, "collectPodLogs").mockImplementation(async request => {
    requests.push(request); request.onLine?.("2026-11-04T09:08:34Z INFO trace-a");
    return { ...ok, captureStatus: "complete", bytesRead: 50, attempts: 1 };
  });
  const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    const padding = variant === "default" ? 600_000 : variant === "profile" ? 300_000 : 30_000;
    const result = await logCommand.run(context, { bizIds: ["biz-a"], services: ["api"],
      ...(variant === "cli" ? { timePadding: "30s" } : {}),
      traceWindows: [{ bizId: "biz-a", traceId: "trace-a", startMs: start, endMs: start + 2500 }],
    });
    expect(result.status).toBe(CommandStatus.Ok);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.sinceTime).toBe(new Date(start - padding).toISOString());
    expect(requests[0]!.untilTime).toBe(new Date(start + 2500 + padding).toISOString());
    const artifact = result.output!.items[0]!.artifacts[0]!;
    const saved = JSON.parse(await Bun.file(join(artifact.path, "collection.json")).text());
    expect(saved.params.since_time).toBe(requests[0]!.sinceTime);
    expect(saved.params.until_time).toBe(requests[0]!.untilTime);
  } finally {
    for (const mock of [ensure, exec, version, logs, stdout]) mock.mockRestore();
    await context.disposeClients();
    for (const artifact of context.artifacts.list()) rmSync(dirname(artifact.path), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
