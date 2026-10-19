import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Executor, ExecResult } from "@compforge/harness-toolbox/kubernetes/executor";
import {
  applyMemoryLimitsCmd, assertSameMemoryTarget, inspectMemoryResizeTarget, memoryResizeHelperMutation,
  parseMemoryHierarchy, type MemoryHierarchy, type MemoryResizeTarget,
} from "../src/infra/target/memory-resize";
import { provisionMemoryResize } from "../src/provision/resize/command";
import { effectiveMemoryLimit, parseResizeMemory, planMemoryGrowth, validateResizeOptions } from "../src/provision/resize/plan";
import type { ResizeRecord } from "../src/provision/resize/model";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const GIB = 1024 ** 3;
const unlimited = "9223372036854771712";
const target: MemoryResizeTarget = {
  namespace: "default", pod: "worker-0", podUid: "12345678-1234-1234-1234-123456789abc",
  container: "server", containerId: `containerd://${"a".repeat(64)}`, restartCount: 1,
  node: "node-a", image: "example/worker:1", imagePullSecrets: [{ name: "registry" }], declaredMemory: "4Gi",
  podCgroupPath: "/kubepods/burstable/pod12345678-1234-1234-1234-123456789abc",
  cgroupPath: `/kubepods/burstable/pod12345678-1234-1234-1234-123456789abc/${"a".repeat(64)}`,
};

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "doctor-resize-test-")); roots.push(path); return path;
}
function hierarchy(): MemoryHierarchy {
  const paths = [target.cgroupPath, target.podCgroupPath, "/kubepods/burstable", "/kubepods", "/"];
  return {
    nodeAvailableBytes: String(32 * GIB),
    groups: paths.map((path, i) => ({ path, inode: String(100 + i), limitBytes: i < 2 ? String(4 * GIB) : unlimited, usageBytes: String(3 * GIB) })),
  };
}
function result(stdout = "", ok = true): ExecResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr: ok ? "" : "injected failure", durationMs: 1, timedOut: false, command: [] };
}
function podJson(containerId = target.containerId, sidecar = false): string {
  return JSON.stringify({
    metadata: { name: target.pod, namespace: target.namespace, uid: target.podUid },
    spec: { nodeName: target.node, imagePullSecrets: target.imagePullSecrets,
      containers: [{ name: target.container, image: target.image, resources: { limits: { memory: "4Gi" } } },
        ...(sidecar ? [{ name: "sidecar", image: "example/sidecar:1", resources: { limits: { memory: "2Gi" } } }] : [])] },
    status: { phase: "Running", containerStatuses: [{ name: target.container, containerID: containerId, ready: true,
      restartCount: 1, state: { running: { startedAt: "2026-01-01T00:00:00Z" } } }] },
  });
}
function hierarchyOutput(value: MemoryHierarchy): string {
  return `available_kib=${BigInt(value.nodeAvailableBytes) / 1024n}\n` + value.groups.map(group =>
    `group=${group.path}\ninode=${group.inode}\nlimit=${group.limitBytes}\nusage=${group.usageBytes}\n`
    + (group.memswLimitBytes ? `memsw=${group.memswLimitBytes}\n` : "")).join("");
}

test("resize plans parent before child, preserves exact 64-bit ancestor limits, and does not shrink", () => {
  const facts = hierarchy();
  expect(parseMemoryHierarchy(hierarchyOutput(facts))).toEqual(facts);
  expect(effectiveMemoryLimit(facts)).toBe(String(4 * GIB));
  expect(planMemoryGrowth(target, facts, parseResizeMemory("8Gi")).map(change => change.path))
    .toEqual([target.podCgroupPath, target.cgroupPath]);
  expect(() => planMemoryGrowth(target, facts, parseResizeMemory("2Gi"))).toThrow("不能降低");
  expect(planMemoryGrowth(target, facts, parseResizeMemory("4Gi"))).toEqual([]);
  expect(() => validateResizeOptions({ interactive: false })).toThrow("--memory");
  expect(() => validateResizeOptions({ interactive: true })).not.toThrow();
  expect(() => parseResizeMemory("1e99")).toThrow();
  expect(() => parseResizeMemory("1Ki")).toThrow();
});

test("resize refuses insufficient node, ancestor and memsw capacity", () => {
  const node = hierarchy(); node.nodeAvailableBytes = String(GIB);
  expect(() => planMemoryGrowth(target, node, String(8 * GIB))).toThrow("节点可用内存不足");
  const ancestor = hierarchy(); ancestor.groups[2]!.limitBytes = String(6 * GIB);
  expect(() => planMemoryGrowth(target, ancestor, String(8 * GIB))).toThrow("上层 cgroup");
  const memsw = hierarchy(); memsw.groups[0]!.memswLimitBytes = String(4 * GIB);
  expect(() => planMemoryGrowth(target, memsw, String(8 * GIB))).toThrow("memsw");
  expect(() => parseMemoryHierarchy("available_kib=1\ngroup=/\nlimit=12\n")).toThrow("证据不完整");
});

test("helper is bound to the target node and writable Pod subtree and copies registry configuration", () => {
  const mutation = memoryResizeHelperMutation(target, "doctor-resize-test", ["/bin/sleep", "600"]);
  expect(mutation.execute.stdin).toBe(mutation.dryRun.stdin);
  const manifest = JSON.parse(mutation.execute.stdin as string);
  expect(manifest.spec.nodeName).toBe(target.node);
  expect(manifest.spec.imagePullSecrets).toEqual(target.imagePullSecrets);
  expect(manifest.spec.automountServiceAccountToken).toBe(false);
  expect(manifest.spec.containers[0].securityContext).toMatchObject({ runAsUser: 0, allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } });
  expect(manifest.spec.volumes[1].hostPath.path).toBe(`/sys/fs/cgroup/memory${target.podCgroupPath}`);
  expect(manifest.spec.activeDeadlineSeconds).toBe(600);
});

test("target discovery binds the actual cgroup and rejects a stale container or foreign path", async () => {
  let path = target.cgroupPath;
  const executor: Executor = { run: async () => result(podJson()), exec: async () => result(path) };
  const discovered = await inspectMemoryResizeTarget(executor, target.pod, target.container);
  assertSameMemoryTarget(target, discovered);
  expect(() => assertSameMemoryTarget(target, { ...discovered, containerId: "containerd://new" })).toThrow("实例已变化");
  path = `/unrelated/${"a".repeat(64)}`;
  await expect(inspectMemoryResizeTarget(executor, target.pod, target.container)).rejects.toThrow("不匹配");
});

test("remote write script checks all cgroups before writing and refuses out-of-scope or decreasing changes", () => {
  const mount = root();
  const child = join(mount, "a".repeat(64)); mkdirSync(child);
  const facts = hierarchy();
  for (const [i, path] of [child, mount].entries()) {
    writeFileSync(join(path, "memory.limit_in_bytes"), String(4 * GIB));
    facts.groups[i]!.inode = String(statSync(path).ino);
  }
  const changes = planMemoryGrowth(target, facts, String(8 * GIB));
  const stale = changes.map((change, i) => ({ ...change, inode: i === 1 ? "0" : change.inode }));
  const failed = Bun.spawnSync(applyMemoryLimitsCmd(target, stale, mount));
  expect(failed.exitCode).not.toBe(0);
  expect(readFileSync(join(mount, "memory.limit_in_bytes"), "utf8")).toBe(String(4 * GIB));
  const applied = Bun.spawnSync(applyMemoryLimitsCmd(target, changes, mount));
  expect(applied.exitCode).toBe(0);
  expect(readFileSync(join(child, "memory.limit_in_bytes"), "utf8").trim()).toBe(String(8 * GIB));
  expect(() => applyMemoryLimitsCmd(target, [{ ...changes[0]!, path: "/kubepods" }])).toThrow("超出");
  expect(() => applyMemoryLimitsCmd(target, [{ ...changes[0]!, afterBytes: "1" }])).toThrow("不能降低");
});

interface FakeOptions { changedLimit?: boolean; partial?: boolean; createFailure?: boolean; waitFailure?: boolean; cleanupFailure?: boolean; stale?: boolean; admissionFailure?: boolean }
function fakeRuntime(path: string, opts: FakeOptions = {}) {
  const facts = hierarchy();
  if (opts.changedLimit) facts.groups[0]!.limitBytes = String(6 * GIB);
  const calls: string[] = [];
  let writes = 0;
  const executor: Executor = {
    run: async (args) => {
      calls.push(args.join(" "));
      if (args[0] === "auth") return result("yes");
      if (args[0] === "create") return result("", !(args.includes("--dry-run=server") ? opts.admissionFailure : opts.createFailure));
      if (args[0] === "wait") return result("", !opts.waitFailure);
      if (args[0] === "delete") return result("", !opts.cleanupFailure);
      if (args[0] === "get") return result(podJson(opts.stale ? `containerd://${"b".repeat(64)}` : undefined));
      throw new Error(`Unexpected run: ${args.join(" ")}`);
    },
    exec: async (selected, command) => {
      if (selected.pod === target.pod) return result(target.cgroupPath);
      if (command[3] === "doctor-memory-inspect") return result(hierarchyOutput(facts));
      if (command[3] === "doctor-memory-apply") {
        const journal = JSON.parse(readFileSync(path, "utf8")) as ResizeRecord;
        expect(journal.result.status).toBe("applying");
        expect(journal.before!.groups[0]!.limitBytes).toBe(String(4 * GIB));
        writes++;
        facts.groups[1]!.limitBytes = String(8 * GIB);
        if (!opts.partial) facts.groups[0]!.limitBytes = String(8 * GIB);
        return result("parent changed", !opts.partial);
      }
      throw new Error("Unexpected exec");
    },
  };
  return { executor, calls, writes: () => writes };
}
async function operation(options: FakeOptions = {}, deniedAt?: number, signal?: AbortSignal) {
  const output = join(root(), "operation.json");
  const runtime = fakeRuntime(output, options);
  let approvals = 0;
  const code = await provisionMemoryResize({
    executor: runtime.executor, target, keepalive: ["/bin/sleep", "600"], requestedBytes: String(8 * GIB), expectedLimitBytes: String(4 * GIB), output, signal,
    approve: async () => ({ approved: ++approvals !== deniedAt, source: "prompt" }),
  });
  return { ...runtime, code, record: JSON.parse(readFileSync(output, "utf8")) as ResizeRecord, approvals, output };
}

test("manual resize persists original values before mutation, verifies the instance and cleans up", async () => {
  const outcome = await operation();
  expect(outcome.code).toBe(0);
  expect(outcome.approvals).toBe(2);
  expect(outcome.writes()).toBe(1);
  expect(outcome.record.result.status).toBe("succeeded");
  expect(outcome.record.after!.groups[0]!.limitBytes).toBe(String(8 * GIB));
  expect(outcome.record.result.helperDeleted).toBe(true);
  expect(statSync(outcome.output).mode & 0o777).toBe(0o600);
});

test("declining either preparation or cgroup adjustment prevents writes", async () => {
  for (const deniedAt of [1, 2]) {
    const outcome = await operation({}, deniedAt);
    expect(outcome.code).toBe(130);
    expect(outcome.writes()).toBe(0);
    expect(outcome.record.result.status).toBe("cancelled");
    expect(outcome.record.result.helperDeleted).toBe(true);
    expect(outcome.calls.some(call => call.startsWith("delete"))).toBe(deniedAt === 2);
  }
});

test("partial apply is retained as failure with observed values and no rollback", async () => {
  const outcome = await operation({ partial: true });
  expect(outcome.code).toBe(1);
  expect(outcome.writes()).toBe(1);
  expect(outcome.record.result.status).toBe("failed");
  expect(outcome.record.after!.groups[0]!.limitBytes).toBe(String(4 * GIB));
  expect(outcome.record.after!.groups[1]!.limitBytes).toBe(String(8 * GIB));
  expect(outcome.record.result.helperDeleted).toBe(true);
});

test("admission, helper startup, stale target, cancellation and cleanup failures remain failures", async () => {
  for (const options of [{ admissionFailure: true }, { createFailure: true }, { waitFailure: true }, { stale: true }]) {
    const outcome = await operation(options);
    expect(outcome.code).toBe(1);
    expect(outcome.writes()).toBe(0);
    expect(outcome.record.result.status).toBe("failed");
  }
  const controller = new AbortController(); controller.abort();
  const cancelled = await operation({}, undefined, controller.signal);
  expect(cancelled.writes()).toBe(0);
  const cleanup = await operation({ cleanupFailure: true });
  expect(cleanup.code).toBe(1);
  expect(cleanup.record.result.helperDeleted).toBe(false);
  expect(cleanup.record.result.status).toBe("failed");
});

test("changing the container limit after selection stops before cgroup writes", async () => {
  const outcome = await operation({ changedLimit: true });
  expect(outcome.code).toBe(1);
  expect(outcome.writes()).toBe(0);
  expect(outcome.record.result.reason).toContain("重新选择");
  expect(outcome.record.result.helperDeleted).toBe(true);
});


test("growing a selected container preserves the Pod budget for siblings and checks the larger parent plan", () => {
  const facts = hierarchy();
  facts.groups[1]!.limitBytes = String(6 * GIB); // 4 GiB server plus 2 GiB sidecar.
  const changes = planMemoryGrowth(target, facts, String(8 * GIB));
  expect(changes.map(change => [change.path, change.afterBytes])).toEqual([
    [target.podCgroupPath, String(10 * GIB)], [target.cgroupPath, String(8 * GIB)],
  ]);
  facts.groups[2]!.limitBytes = String(9 * GIB);
  expect(() => planMemoryGrowth(target, facts, String(8 * GIB))).toThrow("上层 cgroup");
  facts.groups[2]!.limitBytes = unlimited;
  facts.groups[1]!.memswLimitBytes = String(9 * GIB);
  expect(() => planMemoryGrowth(target, facts, String(8 * GIB))).toThrow("memsw");
  delete facts.groups[1]!.memswLimitBytes;
  facts.groups[1]!.limitBytes = unlimited;
  expect(planMemoryGrowth(target, facts, String(8 * GIB)).map(change => change.path)).toEqual([target.cgroupPath]);
});

test("target discovery accepts the explicitly selected business container in a multi-container Pod", async () => {
  const executor: Executor = {
    run: async () => result(podJson(undefined, true)),
    exec: async selected => { expect(selected.container).toBe("server"); return result(target.cgroupPath); },
  };
  const discovered = await inspectMemoryResizeTarget(executor, target.pod, "server");
  assertSameMemoryTarget(target, discovered);
  expect(discovered.image).toBe(target.image);
});
