import { expect, spyOn, test } from "bun:test";
import { createServiceCatalog, type PluginDefinition } from "@compforge/doctor-plugin";
import { KubectlExecutor } from "@compforge/harness-toolbox/kubernetes/executor";
import { ClientNodePodLogAccess } from "@compforge/harness-toolbox/kubernetes/client-node-pod-log";
import { parsePods } from "@compforge/harness-toolbox/kubernetes/pod";
import type { PodLogRequest } from "@compforge/harness-toolbox/kubernetes/pod-log";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CommandContext, CommandStatus } from "../src/command";
import { logCommand, type LogInput } from "../src/collect/log/command";
import { createTraceLineCollector, resolveLogTimeWindow } from "../src/collect/log/config";
import { writeLogHtmlReport } from "../src/collect/log/html";

const plugin: PluginDefinition = { id: "log-only", version: "1.0.0", services: createServiceCatalog([
  { component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } }, name: "api", workloads: [], capabilities: { log: { default: true } } },
  { component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } }, name: "worker", workloads: [], capabilities: { log: { default: false } } },
]) };
const ok = { ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false, command: [] };
const pods = parsePods(JSON.stringify({ items: [{
  metadata: { name: "pod-1", uid: "uid-1" }, spec: { containers: [{ name: "app" }] },
  status: { phase: "Running", containerStatuses: [{ name: "app", containerID: "current", restartCount: 1,
    lastState: { terminated: { containerID: "previous" } } }] },
}] }), "test");

for (const variant of ["defaults", "explicit", "partial", "trace-provider", "unresolved"] as const) {
  test(`log command: ${variant}, bounded collection and trace resolution isolation`, async () => {
    const root = mkdtempSync(join(tmpdir(), "doctor-log-window-test-"));
    const kubeconfig = join(root, "kubeconfig");
    writeFileSync(kubeconfig, "apiVersion: v1\nkind: Config\nclusters: []\ncontexts: []\nusers: []\n");
    let resolutions = 0;
    const activePlugin: PluginDefinition = variant === "trace-provider" || variant === "unresolved" ? {
      ...plugin, services: createServiceCatalog([{ component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } }, name: "api", workloads: [], capabilities: {
        log: { default: true }, traceId: { access: {}, endpoint: { host: "unused", port: 80 }, resolve: async () => {
          resolutions++;
          if (variant === "trace-provider") throw new Error("No-ID collection must not resolve traces");
          return undefined;
        } },
      } }]),
    } : plugin;
    const context = new CommandContext({ kubernetes: {
      kubeconfig: { kubeconfig, source: "flag" }, channel: { available: true, client: ok },
    } }, {
      name: "test", configPath: "", value: { readonly: true, namespace: "test", kube: { kubeconfig_path: kubeconfig } }, pluginConfig: {},
    }, { plugin: activePlugin });
    const ensure = spyOn(context, "ensureEnvironment").mockResolvedValue(undefined);
    const exec = spyOn(KubectlExecutor.prototype, "run").mockImplementation(async args => {
      if (args[0] === "auth") return { ...ok, stdout: "yes\n" };
      throw new Error(`unexpected remote call: ${args.join(" ")}`);
    });
    const version = spyOn(ClientNodePodLogAccess.prototype, "clientVersion").mockResolvedValue(ok);
    const discover = spyOn(ClientNodePodLogAccess.prototype, "listServicePods").mockImplementation(async services => {
      expect(services).toEqual([variant === "explicit" ? "worker" : "api"]);
      return { serviceCapture: ok, podCapture: ok, byService: { [services[0]!]: ["pod-1"] }, pods };
    });
    const requests: PodLogRequest[] = [];
    const logs = spyOn(ClientNodePodLogAccess.prototype, "collectPodLogs").mockImplementation(async request => {
      requests.push(request);
      expect(request.limitBytes).toBeGreaterThan(0);
      expect(request.limitBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
      request.onLine?.("[pod/pod-1/app] 2026-09-16T01:00:01Z INFO unrelated request");
      request.onLine?.("[pod/pod-1/app] 2026-09-16T01:00:02Z ERROR database failed");
      request.onLine?.('2026-09-16T01:00:02Z   File "app.py", line 3');
      return { ...ok, captureStatus: variant === "partial" ? "partial" : "complete", bytesRead: 200, attempts: 1,
        stderr: variant === "partial" ? "capture byte limit" : "" };
    });
    const input: LogInput = { bizIds: variant === "unresolved" ? ["unknown-request"] : [], ...(variant === "explicit" ? {
      services: "worker", sinceTime: "2026-09-16T01:00:00Z", untilTime: "2026-09-16T02:00:00Z", errorsOnly: true,
    } : {}) };
    const started = Date.now();
    let outputDir: string | undefined;
    try {
      const result = await logCommand.run(context, input);
      if (variant === "unresolved") {
        expect(result.status).toBe(CommandStatus.Failed);
        expect(resolutions).toBe(1);
        expect(discover).not.toHaveBeenCalled();
        expect(logs).not.toHaveBeenCalled();
        return;
      }
      expect(resolutions).toBe(0);
      if (result.status === CommandStatus.Failed) throw new Error(result.reason);
      expect(result.status).toBe(variant === "partial" ? CommandStatus.Partial : CommandStatus.Ok);
      expect(result.output?.items).toHaveLength(1);
      const item = result.output!.items[0]!;
      expect(item.bizId).toBeUndefined();
      outputDir = item.artifacts[0]!.path;
      expect(requests.map(request => !!request.previous).sort()).toEqual([false, true]);
      expect(discover).toHaveBeenCalledTimes(1);
      for (const request of requests) {
        if (variant === "explicit") {
          expect(request.sinceTime).toBe(input.sinceTime);
          expect(request.untilTime).toBe(input.untilTime);
        } else {
          expect(request.since).toBe("6h");
          expect(Date.parse(request.untilTime!)).toBeGreaterThanOrEqual(started);
          expect(Date.parse(request.untilTime!)).toBeLessThanOrEqual(Date.now());
        }
      }
      const manifest = JSON.parse(readFileSync(join(outputDir, "manifest.json"), "utf8"));
      expect(manifest.target.mode).toBe("service");
      expect(manifest.target.biz_id).toBeUndefined();
      expect(manifest.target.trace_ids).toEqual([]);
      const timeline = readFileSync(join(outputDir, "timeline.jsonl"), "utf8");
      expect(timeline).toContain("database failed");
      expect(timeline).toContain("app.py");
      expect(timeline).toContain('"instance":"previous"');
      if (variant === "explicit") expect(timeline).not.toContain("unrelated request");
      else expect(timeline).toContain("unrelated request");
      const html = join(root, "report.html");
      writeLogHtmlReport(outputDir, html, "test");
      expect(readFileSync(html, "utf8")).toContain("不按业务 ID 过滤");
      expect(readFileSync(html, "utf8")).not.toContain("trace 命中");
    } finally {
      await context.disposeClients();
      for (const mock of [ensure, exec, version, discover, logs]) mock.mockRestore();
      if (outputDir) rmSync(dirname(outputDir), { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("business ID still requires traceId before any environment access", async () => {
  const context = new CommandContext({}, undefined, { plugin });
  const ensure = spyOn(context, "ensureEnvironment").mockImplementation(async () => { throw new Error("unexpected environment access"); });
  try {
    const result = await logCommand.run(context, { bizIds: ["request-1"] });
    expect(result.status).toBe(CommandStatus.Failed);
    if (result.status !== CommandStatus.Failed) throw new Error("expected failure");
    expect(result.reason).toContain("traceId");
    expect(ensure).not.toHaveBeenCalled();
  } finally { ensure.mockRestore(); await context.disposeClients(); }
});

test("no-ID defaults retain a finite window; content filters preserve error stacks without matching an ID", () => {
  expect(resolveLogTimeWindow({})).toEqual({ since: "6h" });
  const collector = createTraceLineCollector([], /ERROR/);
  collector.push("INFO not selected");
  collector.push("ERROR failed");
  collector.push("  stack frame");
  collector.push("INFO end");
  expect(collector.events).toEqual(["ERROR failed\n  stack frame"]);
});
