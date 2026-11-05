import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServiceCatalog, type LogWorkloadsExtension } from "@compforge/doctor-plugin";
import { KubectlExecutor } from "@compforge/harness-toolbox/kubernetes/executor";
import { ClientNodePodLogAccess } from "@compforge/harness-toolbox/kubernetes/client-node-pod-log";
import { parsePods } from "@compforge/harness-toolbox/kubernetes/pod";
import { traceExtension } from "../../packages/plugin/tests/extension-fixture";
import { CommandContext, CommandStatus } from "../src/command";
import { logCommand } from "../src/collect/log/command";
import { logService, podDiscoveryExecutor } from "./log-fixture";

// @case log-workloads-request-isolation: one batch may select different subsets, no targets, or fail lookup.
for (const ids of [["a", "b", "none", "broken"], ["none"], ["broken"], ["a", "broken"]]) {
  test(`log.workloads isolates discovery/capture and preserves empty/failure results: ${ids}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "doctor-log-workloads-"));
    const kubeconfig = join(root, "kubeconfig");
    writeFileSync(kubeconfig, "apiVersion: v1\nkind: Config\nclusters: []\ncontexts: []\nusers: []\n");
    const ok = { ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false, command: [] };
    const extension: LogWorkloadsExtension = {
      id: "targets", kind: "log.workloads", access: {},
      run: async (_context, input) => {
        if (input.bizId === "broken") throw new Error("association unavailable");
        return { data: input.bizId === "none" ? [] : [input.bizId === "a" ? "main" : "worker"],
          summary: { title: "Workloads", text: "request-related workloads", fields: [] } };
      },
    };
    const service = { ...logService(), workloads: ["main", "worker"].map(name => ({
      name, platform: "kubernetes" as const, location: { kind: "labels" as const, labels: { app: name } },
    })), extensions: [extension, traceExtension({ access: {}, endpoint: { host: "unused", port: 80 },
      resolve: async (_context, id) => ({ traceId: `trace-${id}`, resolvedAs: "biz_id" }) })] };
    const context = new CommandContext({ kubernetes: { kubeconfig: { kubeconfig, source: "flag" }, channel: { available: true, client: ok } } }, {
      name: "test", configPath: "", value: { readonly: true, namespace: "test", kube: { kubeconfig_path: kubeconfig } }, pluginConfig: {},
    }, { format: "summary", plugin: { id: "fixture", version: "1", services: createServiceCatalog([service]) } });
    const ensure = spyOn(context, "ensureEnvironment").mockResolvedValue(undefined);
    const discovered: string[] = [];
    const pods = (name: string) => parsePods(JSON.stringify({ items: [{ metadata: { name, uid: name + "-uid" },
      spec: { containers: [{ name: "app" }] }, status: { phase: "Running", containerStatuses: [{ name: "app", containerID: name + "-container", restartCount: 0 }] } }] }), "test");
    const exec = spyOn(KubectlExecutor.prototype, "run").mockImplementation(args => {
      if (args[0] === "auth") return Promise.resolve({ ...ok, stdout: "yes\n" });
      const name = args[2] === "-l" ? args[3]!.replace("app=", "") : args[2]!;
      if (args[2] === "-l") discovered.push(name);
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
      result = await logCommand.run(context, { bizIds: ids, sinceTime: "2026-11-05T00:00:00Z" });
      expect(result.output?.items.map(item => item.status)).toEqual(ids.map(id => id === "broken" ? CommandStatus.Failed : CommandStatus.Ok));
      const expected = ids.flatMap(id => id === "a" ? ["main"] : id === "b" ? ["worker"] : []);
      expect(discovered.sort()).toEqual(expected.sort());
      expect(captured.sort()).toEqual(expected.sort());
      for (const item of result.output!.items) {
        if (item.bizId === "none" || item.bizId === "broken") {
          expect(item.artifacts).toEqual([]);
          expect(item.reason).toContain(item.bizId === "none" ? "没有与本次输入相关" : "association unavailable");
          continue;
        }
        expect(item.stats?.podCount).toBe(1);
        const diagnosis = JSON.parse(readFileSync(join(item.artifacts[0]!.path, "diagnosis.json"), "utf8"));
        expect(diagnosis.evidence.facts.servicePods.byService.api.map((target: { instance: { workload: string } }) => target.instance.workload))
          .toEqual([item.bizId === "a" ? "main" : "worker"]);
      }
      if (!expected.length) expect(version).not.toHaveBeenCalled();
    } finally {
      await context.disposeClients();
      for (const artifact of result?.artifacts ?? []) rmSync(artifact.path, { recursive: true, force: true });
      ensure.mockRestore(); exec.mockRestore(); version.mockRestore(); logs.mockRestore(); stdout.mockRestore(); stderr.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
