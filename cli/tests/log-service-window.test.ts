import { traceExtension } from "../../packages/plugin/tests/extension-fixture";
import { logService, podDiscoveryExecutor } from "./log-fixture";
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
import { buildLogPattern, createTraceLineCollector, resolveLogTimeWindow } from "../src/collect/log/config";
import { writeLogHtmlReport } from "../src/collect/log/html";

const plugin: PluginDefinition = {
  id: "log-only", version: "1.0.0", services: createServiceCatalog([
    {
      component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
      name: "api",
      workloads: logService("api").workloads,
      logs: { default: true }
    },
    {
      component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
      name: "worker",
      workloads: logService("worker").workloads,
      logs: { default: false }
    },
  ])
};
const ok = { ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false, command: [] };
const pods = parsePods(JSON.stringify({
  items: [{
    metadata: { name: "pod-1", uid: "uid-1" }, spec: { containers: [{ name: "app" }] },
    status: {
      phase: "Running", containerStatuses: [{
        name: "app", containerID: "current", restartCount: 1,
        lastState: { terminated: { containerID: "previous" } }
      }]
    },
  }]
}), "test");

for (const variant of ["defaults", "explicit", "partial", "trace-provider", "unresolved"] as const) {
  test(`log command: ${variant}, bounded collection and trace resolution isolation`, async () => {
    const root = mkdtempSync(join(tmpdir(), "doctor-log-window-test-"));
    const kubeconfig = join(root, "kubeconfig");
    writeFileSync(kubeconfig, "apiVersion: v1\nkind: Config\nclusters: []\ncontexts: []\nusers: []\n");
    let resolutions = 0;
    const activePlugin: PluginDefinition = variant === "trace-provider" || variant === "unresolved" ? {
      ...plugin, services: createServiceCatalog([{
        component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
        name: "api",
        workloads: logService("api").workloads,
        logs: { default: true },
        extensions: [traceExtension({
          access: {}, endpoint: { host: "unused", port: 80 }, resolve: async () => {
            resolutions++;
            if (variant === "trace-provider") throw new Error("No-ID collection must not resolve traces");
            return undefined;
          }
        })]
      }]),
    } : plugin;
    const context = new CommandContext({
      kubernetes: {
        kubeconfig: { kubeconfig, source: "flag" }, channel: { available: true, client: ok },
      }
    }, {
      name: "test", configPath: "", value: { readonly: true, namespace: "test", kube: { kubeconfig_path: kubeconfig } }, pluginConfig: {},
    }, { plugin: activePlugin });
    const ensure = spyOn(context, "ensureEnvironment").mockResolvedValue(undefined);
    let discoveries = 0;
    const discovery = podDiscoveryExecutor(pods, () => { discoveries++; });
    const exec = spyOn(KubectlExecutor.prototype, "run").mockImplementation(async args => {
      if (args[0] === "auth") return { ...ok, stdout: "yes\n" };
      if (args[0] === "config" || args[2] === "pod-1") return discovery.run(args);
      expect(args).toEqual(["get", "pods", "-l", `app=${variant === "explicit" ? "worker" : "api"}`, "-o", "json"]);
      return discovery.run(args);
    });
    const version = spyOn(ClientNodePodLogAccess.prototype, "clientVersion").mockResolvedValue(ok);

    const requests: PodLogRequest[] = [];
    const logs = spyOn(ClientNodePodLogAccess.prototype, "collectPodLogs").mockImplementation(async request => {
      requests.push(request);
      expect(request.limitBytes).toBeGreaterThan(0);
      expect(request.limitBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
      request.onLine?.("[pod/pod-1/app] 2026-09-16T01:00:01Z INFO unrelated request");
      request.onLine?.("[pod/pod-1/app] 2026-09-16T01:00:02Z ERROR database failed");
      request.onLine?.('2026-09-16T01:00:02Z   File "app.py", line 3');
      return {
        ...ok, captureStatus: variant === "partial" ? "partial" : "complete", bytesRead: 200, attempts: 1,
        stderr: variant === "partial" ? "capture byte limit" : ""
      };
    });
    const input: LogInput = {
      bizIds: variant === "unresolved" ? ["unknown-request"] : [], ...(variant === "explicit" ? {
        services: "worker", sinceTime: "2026-09-16T01:00:00Z", untilTime: "2026-09-16T02:00:00Z", errorsOnly: true,
      } : {})
    };
    const started = Date.now();
    let outputDir: string | undefined;
    try {
      const result = await logCommand.run(context, input);
      if (variant === "unresolved") {
        expect(result.status).toBe(CommandStatus.Failed);
        expect(resolutions).toBe(1);
        expect(discoveries).toBe(0);
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
      expect(discoveries).toBe(1);
      expect(exec.mock.calls.filter(([args]) => args[0] === "auth").map(([args]) => args.join(" ")))
        .toEqual(["auth can-i get pods/log", "auth can-i list pods"]);
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
      const manifest = JSON.parse(readFileSync(join(outputDir, "collection.json"), "utf8"));
      expect(manifest.target.mode).toBe("service");
      expect(manifest.target.biz_id).toBeUndefined();
      expect(manifest.target.trace_ids).toEqual([]);
      const timeline = readFileSync(join(outputDir, "timeline.jsonl"), "utf8");
      expect(timeline).toContain("database failed");
      expect(timeline).toContain("app.py");
      expect(timeline).toContain('"instance":"previous"');
      const records = timeline.trim().split("\n").map((line) => JSON.parse(line));
      const currentMessages = records.filter((record) => record.instance === "current")
        .map((record) => record.message).join("\n");
      const previousTail = records.filter((record) => record.instance === "previous" && record.unfiltered)
        .map((record) => record.message).join("\n");
      if (variant === "explicit") {
        expect(currentMessages).not.toContain("unrelated request");
        // errors-only 下 previous 容器保留未过滤尾部（被杀/崩溃中断点取证），current 不受影响
        expect(previousTail).toContain("unrelated request");
        expect(readFileSync(join(outputDir, "summary.md"), "utf8")).toContain("previous 日志");
      } else {
        expect(currentMessages).toContain("unrelated request");
        expect(previousTail).toBe("");
      }
      const html = join(root, "report.html");
      writeLogHtmlReport(outputDir, html, "test");
      expect(readFileSync(html, "utf8")).toContain("不按业务 ID 过滤");
      expect(readFileSync(html, "utf8")).not.toContain("trace 命中");
    } finally {
      await context.disposeClients();
      for (const mock of [ensure, exec, version, logs]) mock.mockRestore();
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
    expect(result.reason).toContain("trace.resolve");
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
  expect(collector.drainTail()).toEqual([]);
});

test("collector tail ring keeps recent unselected lines for crash forensics", () => {
  const collector = createTraceLineCollector([], /ERROR/, undefined, { keepTail: 3 });
  collector.push("INFO one");
  collector.push("INFO two");
  collector.push("ERROR failed");
  collector.push("  stack frame");
  collector.push("INFO three");
  collector.push("INFO four");
  expect(collector.events).toEqual(["ERROR failed\n  stack frame"]);
  // keepTail=3 的环形缓冲最终是 [stack frame(选中), INFO three, INFO four]，只回吐未命中的行
  expect(collector.drainTail()).toEqual(["INFO three", "INFO four"]);
});

test("errors-only 合并 Service 声明的业务错误签名", () => {
  const pattern = buildLogPattern(true, undefined, ["error_type=\\d+", "\" 5\\d\\d"]);
  expect(pattern!.test('2026-09-21 13:08:40 | WARNING | t | sse stream failed: error_type=104500')).toBe(true);
  expect(pattern!.test('10.0.0.1 - "POST /v1/chat HTTP/1.1" 500')).toBe(true);
  expect(pattern!.test("INFO ordinary line")).toBe(false);
  // 非 errors-only 不按内容过滤，Service 签名不产生意外筛选
  expect(buildLogPattern(false, undefined, ["error_type=\\d+"])).toBeUndefined();
});
