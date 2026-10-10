import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createServiceCatalog } from "@compforge/doctor-plugin";
import { KubectlExecutor } from "@compforge/harness-toolbox/kubernetes/executor";
import { ClientNodePodLogAccess } from "@compforge/harness-toolbox/kubernetes/client-node-pod-log";
import { parsePods } from "@compforge/harness-toolbox/kubernetes/pod";
import { inspectExtension } from "../../packages/plugin/tests/extension-fixture";
import { CommandContext, CommandStatus } from "../src/command";
import { logCommand } from "../src/collect/log/command";
import { logService, podDiscoveryExecutor } from "./log-fixture";
import { finalizeResult } from "./report-fixture";

for (const variant of ["collected", "partial", "failed"] as const) {
  test(`object-only log command ${variant}: bounded shared capture, attribution and Data child evidence`, async () => {
    const root = mkdtempSync(join(tmpdir(), "doctor-object-log-"));
    const kubeconfig = join(root, "kubeconfig");
    writeFileSync(kubeconfig, "apiVersion: v1\nkind: Config\nclusters: []\ncontexts: []\n");
    const ok = { ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false, command: [] };
    const context = new CommandContext({ kubernetes: { kubeconfig: { kubeconfig, source: "flag" }, channel: { available: true, client: ok } } }, {
      name: "test", configPath: "", value: { readonly: true, namespace: "test", kube: { kubeconfig_path: kubeconfig } }, pluginConfig: {},
    }, { format: "summary", plugin: { id: "objects", version: "1", services: createServiceCatalog([{
      ...logService(), logs: { default: true, identityRelations: { biz_id: ["carrier_id"] } },
      extensions: [inspectExtension({ access: {}, accepts: ["biz_id"], expands: ["carrier_id"], provides: ["reference"],
        inspect: async (_context, queries) => queries.map(({ identity }) => variant === "failed" ? {
          identity, status: "failed" as const, reason: "database unavailable",
        } : { identity, status: "collected" as const, result: {
          resolution: { inputId: identity.value, resolvedAs: "carrier_id", identifiers: {} },
          facts: [{ factType: "relation" as const, kind: "reference", schemaVersion: 1, from: identity, to: { kind: "carrier_id", value: `carrier-${identity.value}` } }],
          ...(variant === "partial" && identity.value === "a" ? { sources: [{ source: "db/workspace", status: "failed" as const, reason: "denied" }] } : {}),
        } }),
      })],
    }]) } });
    const ensure = spyOn(context, "ensureEnvironment").mockResolvedValue(undefined);
    const pods = parsePods(JSON.stringify({ items: [{ metadata: { name: "server-pod", uid: "uid" }, spec: { containers: [{ name: "app" }] },
      status: { phase: "Running", containerStatuses: [{ name: "app", containerID: "current", restartCount: 0 }] } }] }), "test");
    const discovery = podDiscoveryExecutor(pods);
    const exec = spyOn(KubectlExecutor.prototype, "run").mockImplementation(args => args[0] === "auth" ? Promise.resolve({ ...ok, stdout: "yes\n" }) : discovery.run(args));
    const version = spyOn(ClientNodePodLogAccess.prototype, "clientVersion").mockResolvedValue(ok);
    const logs = spyOn(ClientNodePodLogAccess.prototype, "collectPodLogs").mockImplementation(async request => {
      for (const text of ["ERROR carrier-a observer failed", "ERROR carrier-b cleanup failed", "ERROR carrier-a-other unrelated", "INFO unrelated request"]) {
        request.onLine?.(`[pod/server-pod/app] 2026-09-16T01:00:01Z ${text}`);
      }
      return { ...ok, captureStatus: "complete", bytesRead: 200, attempts: 1 };
    });
    const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    let evidenceDir: string | undefined;
    try {
      const input = { bizIds: ["a", "b"], services: "api", sinceTime: "2026-09-16T01:00:00Z" };
      const result = await logCommand.run(context, input);
      expect(result.status).toBe(variant === "failed" ? CommandStatus.Failed : variant === "partial" ? CommandStatus.Partial : CommandStatus.Ok);
      expect(result.output?.items.map(item => item.status)).toEqual(variant === "failed" ? [CommandStatus.Failed, CommandStatus.Failed] : variant === "partial" ? [CommandStatus.Partial, CommandStatus.Ok] : [CommandStatus.Ok, CommandStatus.Ok]);
      expect(logs).toHaveBeenCalledTimes(variant === "failed" ? 0 : 1);
      for (const item of result.output?.items ?? []) {
        if (!item.artifacts.length) continue;
        const directory = item.artifacts[0]!.path;
        const text = readFileSync(join(directory, "service-logs.txt"), "utf8");
        expect(text).toContain(`[related-object:carrier_id=carrier-${item.bizId}]`);
        expect(text).not.toContain(item.bizId === "a" ? "carrier-b" : "carrier-a");
        expect(text).not.toContain("unrelated");
        const timeline = readFileSync(join(directory, "timeline.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
        expect(timeline.filter(record => record.kind === "log")[0].matches[0]).toMatchObject({ kind: "related-object", identity: { kind: "carrier_id", value: `carrier-${item.bizId}` }, factIndex: 0 });
      }
      await finalizeResult(context, logCommand, result, { format: "summary" }, input);
      evidenceDir = stderr.mock.calls.map(([line]) => String(line)).find(line => line.startsWith("[delivery] Evidence: "))?.trim().slice("[delivery] Evidence: ".length);
      expect(evidenceDir).toBeDefined();
      const manifest = JSON.parse(readFileSync(join(evidenceDir!, "manifest.json"), "utf8"));
      const children = manifest.children.map((child: { manifest: string }) => JSON.parse(readFileSync(join(evidenceDir!, child.manifest), "utf8")));
      const dataChild = children.find((child: { source?: { command?: string } }) => child.source?.command === "data");
      expect(dataChild).toBeDefined();
      expect(dataChild.files.facts.path).toBe("raw/facts.json");
      expect(dataChild.serialization.status).toBe("ok");
      expect(stdout.mock.calls.map(([line]) => String(line)).join("")).toContain(`采集状态：${result.status}`);
    } finally {
      for (const mock of [stdout, stderr, ensure, exec, version, logs]) mock.mockRestore();
      await context.disposeClients();
      for (const artifact of context.artifacts.list()) rmSync(dirname(artifact.path), { recursive: true, force: true });
      if (evidenceDir) rmSync(evidenceDir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
}
