import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServiceCatalog, type RequestWorkloadsExtension, type Workload } from "@compforge/doctor-plugin";
import { KubectlExecutor } from "@compforge/harness-toolbox/kubernetes/executor";
import { ClientNodePodLogAccess } from "@compforge/harness-toolbox/kubernetes/pod/log";
import { parsePods } from "@compforge/harness-toolbox/kubernetes/pod";
import { traceExtension } from "../../packages/plugin/tests/extension-fixture";
import { CommandContext, CommandStatus } from "../src/command";
import { runCollectInspect } from "../src/collect/inspect";
import { logCommand } from "../src/collect/log/command";
import { resolveRequestWorkloads } from "../src/collect/request-workloads";
import { logPlugin, logService, podDiscoveryExecutor } from "./log-fixture";

// @case request-workloads-request-isolation: one batch may select different subsets, no targets, or fail lookup.
for (const ids of [["a", "b", "none", "broken"], ["none"], ["broken"], ["a", "broken"]]) {
  test(`request.workloads isolates discovery/capture and preserves empty/failure results: ${ids}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "doctor-request-workloads-"));
    const kubeconfig = join(root, "kubeconfig");
    writeFileSync(kubeconfig, "apiVersion: v1\nkind: Config\nclusters: []\ncontexts: []\nusers: []\n");
    const ok = { ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false, command: [] };
    const lookups: string[] = [];
    const extension: RequestWorkloadsExtension = {
      id: "targets", kind: "request.workloads", access: {},
      run: async (_context, input) => {
        lookups.push(input.bizId);
        if (input.bizId === "broken") throw new Error("association unavailable");
        return { data: input.bizId === "none" ? [] : [{ name: "runtime", service: "worker", platform: "kubernetes",
          location: { kind: "resource", resource_kind: "Pod", name: "pod-" + input.bizId } }],
          summary: { title: "Workloads", text: "request-related workloads", fields: [] } };
      },
    };
    const service = { ...logService("controller"), logs: undefined, extensions: [extension, traceExtension({ access: {}, endpoint: { host: "unused", port: 80 },
      resolve: async (_context, id) => ({ traceId: `trace-${id}`, resolvedAs: "biz_id" }) })] };
    const context = new CommandContext({ kubernetes: { kubeconfig: { kubeconfig, source: "flag" }, channel: { available: true, client: ok } } }, {
      name: "test", configPath: "", value: { readonly: true, namespace: "test", kube: { kubeconfig_path: kubeconfig } }, pluginConfig: {},
    }, { format: "summary", plugin: { id: "fixture", version: "1", services: createServiceCatalog([service, { ...logService("worker"), extensions: [] }]) } });
    const ensure = spyOn(context, "ensureEnvironment").mockResolvedValue(undefined);
    const discovered: string[] = [];
    const pods = (name: string) => parsePods(JSON.stringify({ items: [{ metadata: { name, uid: name + "-uid" },
      spec: { containers: [{ name: "app" }] }, status: { phase: "Running", containerStatuses: [{ name: "app", containerID: name + "-container", restartCount: 0 }] } }] }), "test");
    const exec = spyOn(KubectlExecutor.prototype, "run").mockImplementation(args => {
      if (args[0] === "auth") return Promise.resolve({ ...ok, stdout: "yes\n" });
      const name = args[2] === "-l" ? args[3]!.replace("app=", "") : args[2]!;
      if (args[0] === "get" && args[1] === "pods") discovered.push(name);
      return podDiscoveryExecutor(pods(name)).run(args);
    });
    const version = spyOn(ClientNodePodLogAccess.prototype, "clientVersion").mockResolvedValue(ok);
    const captured: string[] = [];
    const logs = spyOn(ClientNodePodLogAccess.prototype, "collectPodLogs").mockImplementation(async request => {
      captured.push(request.pod);
      request.onLine?.(`[pod/${request.pod}/app] 2026-11-05T01:00:00Z INFO trace-a trace-b`);
      return { ...ok, captureStatus: "complete", bytesRead: 50, attempts: 1 };
    });
    const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    let result: Awaited<ReturnType<typeof logCommand.run>> | undefined;
    try {
      if (ids.includes("a")) {
        const inspect = await runCollectInspect({ bizId: "a", namespace: "test", services: ["worker"], field: "image" },
          context.plugin, context, new KubectlExecutor({ kubeconfig, namespace: "test" }));
        expect(inspect.status).toBe(CommandStatus.Ok);
        expect(discovered.splice(0)).toEqual(["pod-a"]);
        const artifact = context.artifacts.list().find(artifact => artifact.command === "inspect")!;
        const evidence = JSON.parse(readFileSync(join(artifact.path, "diagnosis.json"), "utf8")).evidence;
        expect(evidence.facts.serviceTargets.services.worker.workloads.runtime.podRuntime.pods[0].pod).toBe("pod-a");
      }
      result = await logCommand.run(context, { bizIds: ids, sinceTime: "2026-11-05T00:00:00Z" });
      expect(result.output?.items.map(item => item.status)).toEqual(ids.map(id => id === "broken" ? CommandStatus.Failed : CommandStatus.Ok));
      const expected = ids.flatMap(id => id === "a" || id === "b" ? ["pod-" + id] : []);
      expect([...new Set(discovered)].sort()).toEqual(expected.sort());
      expect(lookups).toEqual(ids);
      expect(captured.sort()).toEqual(expected.sort());
      for (const item of result.output!.items) {
        if (item.bizId === "none" || item.bizId === "broken") {
          expect(item.artifacts).toEqual([]);
          expect(item.reason).toContain(item.bizId === "none" ? "没有与本次输入相关" : "association unavailable");
          continue;
        }
        expect(item.stats?.podCount).toBe(1);
        const diagnosis = JSON.parse(readFileSync(join(item.artifacts[0]!.path, "diagnosis.json"), "utf8"));
        expect(diagnosis.evidence.facts.servicePods.byService.worker.map((target: { instance: { pod: string } }) => target.instance.pod))
          .toEqual(["pod-" + item.bizId]);
      }
      if (!expected.length) expect(version).not.toHaveBeenCalled();
    } finally {
      await context.disposeClients();
      for (const artifact of [...context.artifacts.list(), ...result?.artifacts ?? []]) rmSync(artifact.path, { recursive: true, force: true });
      ensure.mockRestore(); exec.mockRestore(); version.mockRestore(); logs.mockRestore(); stdout.mockRestore(); stderr.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("malformed and conflicting contributions do not widen or supersede verified targets", async () => {
  const pod = (name: string, target: string) => ({
    platform: "kubernetes" as const, service: "worker", name,
    location: { kind: "resource" as const, resource_kind: "Pod" as const, name: target },
  });
  const provider = (id: string, data: readonly Workload[]): RequestWorkloadsExtension => ({
    id, kind: "request.workloads", access: {},
    run: async () => ({ data, summary: { title: id, fields: [] } }),
  });
  const worker = { ...logService("worker"), extensions: [] };
  const plugin = logPlugin(worker, { ...logService("controller"), extensions: [
    provider("first", [pod("conflict", "old"), pod("valid", "selected")]),
    provider("second", [pod("conflict", "new"), pod("valid", "selected")]),
    provider("invalid", [pod("discard", "unverified"), { ...pod("bad", "bad"), service: "missing" }]),
  ] });
  const context = new CommandContext({}, undefined, { plugin });
  try {
    const scope = await resolveRequestWorkloads(context, plugin.services, "biz", podDiscoveryExecutor([]), { namespace: "ns" });
    expect(scope.gaps.join("\n")).toContain("unknown owner 'missing'");
    expect(scope.gaps.join("\n")).toContain("conflicting Workload worker/conflict");
    expect(scope.catalog.find("worker")!.workloads).toEqual([pod("valid", "selected")]);
    expect(plugin.services.find("worker")!.workloads).toEqual(worker.workloads);
  } finally { await context.disposeClients(); }
});
