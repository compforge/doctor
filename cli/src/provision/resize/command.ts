import { randomUUID } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import type { CommandContext } from "../../command";
import { approvalDeniedReason, type ApprovalGate } from "../../command/approval";
import { inCommandScope } from "../../command/execution-scope";
import { createKubernetesExecutor, resolveKubernetesCommandConfig, resolvePodTarget } from "../../command/kubernetes-target";
import { infra } from "../../infra";
import { executeK8sMutation, inspectK8sMutation } from "../../infra/k8s/mutation";
import { failReason } from "../../infra/k8s/result";
import {
  applyMemoryLimits, assertSameMemoryTarget, inspectMemoryHierarchy, inspectMemoryResizeTarget,
  memoryResizeHelperMutation, type MemoryLimitChange, type MemoryResizeTarget,
} from "../../infra/target/memory-resize";
import { resolveApprovalGate } from "../../terminal/approval";
import { enforceKubernetesAccess } from "../../terminal/kubernetes-access";
import { useLogger } from "../../terminal/log";
import { writeOutput } from "../../terminal/output";
import type { ResizeCliOpts, ResizeRecord } from "./model";
import { effectiveMemoryLimit, parseResizeMemory, planMemoryGrowth, validateResizeOptions } from "./plan";

interface ResizeOperation {
  executor: Executor;
  target: MemoryResizeTarget;
  keepalive: readonly string[];
  requestedBytes: string;
  signal?: AbortSignal;
  approve: ApprovalGate;
  output?: string;
}

/**
 * @spec Resize is an explicit Provision action. Collect never calls it and cleanup never restores limits.
 * @spec Persist the original limits before any cgroup write, including a failed or interrupted apply.
 * @see cli/docs/commands/resize.md
 */
export async function provisionMemoryResize(input: ResizeOperation): Promise<number> {
  const { executor, target } = input;
  const helper = `doctor-resize-${randomUUID().slice(0, 12)}`;
  const path = resolve(input.output ?? `doctor-resize-${target.pod}-${Date.now()}.json`);
  const record: ResizeRecord = {
    schema: "doctor.resize/v1", generatedAt: new Date().toISOString(),
    target, helper, changes: [], approvals: [],
    result: { status: "preparing", helperDeleted: false },
  };
  // Reserve the output before creating remote resources; existing records must not be overwritten.
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  writeOutput(`[resize] 操作记录：${path}\n`);
  const persist = () => {
    const temporary = `${path}.${helper}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  };
  let helperAttempted = false;
  let code = 1;
  try {
    const mutation = memoryResizeHelperMutation(target, helper, input.keepalive);
    const preflight = await inspectK8sMutation(executor, mutation);
    if (!preflight.fact.runnable) throw new Error(`辅助 Pod 预检失败：${preflight.fact.reason}`);
    const preparation = await input.approve({
      id: `resize-helper/${helper}`, risk: "disrupt", title: "在目标节点准备 resize 辅助 Pod",
      target: `namespace/${target.namespace} pod/${target.pod} container/${target.container} node/${target.node}`,
      impact: [
        `使用目标镜像 ${target.image}，以 root 运行并移除全部 capabilities`,
        `只读挂载节点 memory 层级；可写挂载目标 Pod cgroup ${target.podCgroupPath}`,
        "先读取父级限制和节点余量，展示具体调整计划后再次确认",
        "辅助 Pod 最长运行 10 分钟，结束时删除；业务容器不重启",
      ],
    });
    record.approvals.push(preparation);
    if (!preparation.approved) {
      code = 130;
      throw new Error(approvalDeniedReason(preparation.source));
    }
    persist();
    helperAttempted = true;
    input.signal?.throwIfAborted();
    const created = await executeK8sMutation(executor, mutation);
    if (!created.ok) throw new Error(`创建辅助 Pod 失败：${failReason(created)}`);
    const ready = await executor.run(["wait", "--for=condition=Ready", `pod/${helper}`, "--timeout=60s"], { timeoutMs: 65_000 });
    if (!ready.ok) throw new Error(`辅助 Pod 未就绪：${failReason(ready)}`);
    assertSameMemoryTarget(target, await inspectMemoryResizeTarget(executor, target.pod, target.container));
    const before = await inspectMemoryHierarchy(executor, helper, target);
    record.before = before;
    const plan = (hierarchy: typeof before): MemoryLimitChange[] => planMemoryGrowth(target, hierarchy, input.requestedBytes);
    record.changes = plan(before);
    record.result.status = "planned";
    persist();
    if (record.changes.length) {
      const impact = record.changes.map(change => `${change.path}: ${change.beforeBytes} → ${change.afterBytes} bytes`);
      for (const line of impact) useLogger("resize").info(line);
      const decision = await input.approve({
        id: `resize-limits/${helper}`, risk: "disrupt", title: "在线上调内存上限",
        target: `namespace/${target.namespace} pod/${target.pod} container/${target.container}`,
        impact: [...impact,
          `Kubernetes 声明仍为 ${target.declaredMemory ?? "未设置"}；重建或后续调谐可能覆盖此次调整`,
          "本次修改不预留节点内存；新限制保留在当前实例中",
        ],
      });
      record.approvals.push(decision);
      if (!decision.approved) {
        code = 130;
        throw new Error(approvalDeniedReason(decision.source));
      }
      assertSameMemoryTarget(target, await inspectMemoryResizeTarget(executor, target.pod, target.container));
      const fresh = await inspectMemoryHierarchy(executor, helper, target);
      if (JSON.stringify(plan(fresh)) !== JSON.stringify(record.changes)) throw new Error("cgroup 计划已变化，请重新执行并确认");
      record.result.status = "applying";
      persist();
      input.signal?.throwIfAborted();
      const applied = await applyMemoryLimits(executor, helper, target, record.changes);
      record.result.applyOutput = `${applied.stdout}\n${applied.stderr}`.trim();
      // Even a partial write is observed and retained; failure never triggers an unsafe shrink.
      record.after = await inspectMemoryHierarchy(executor, helper, target);
      if (!applied.ok) throw new Error(`调整 cgroup 失败，可能存在部分变更：${failReason(applied)}`);
      assertSameMemoryTarget(target, await inspectMemoryResizeTarget(executor, target.pod, target.container));
      for (const change of record.changes) {
        const current = record.after.groups.find(group => group.path === change.path);
        if (current?.inode !== change.inode || current.limitBytes !== change.afterBytes) throw new Error(`cgroup 读回验证失败：${change.path}`);
      }
      const expected = effectiveMemoryLimit({ ...before, groups: before.groups.map(group => ({
        ...group, limitBytes: record.changes.find(change => change.path === group.path)?.afterBytes ?? group.limitBytes,
      })) });
      if (effectiveMemoryLimit(record.after) !== expected) throw new Error("父级限制发生变化，有效内存上限未达到计划值");
    } else {
      record.after = before;
    }
    record.result.status = "succeeded";
    useLogger("resize").success(`有效内存上限 ${effectiveMemoryLimit(record.after)} bytes；实例保持 Ready，重启次数 ${target.restartCount}`);
    code = 0;
  } catch (error) {
    record.result.status = code === 130 ? "cancelled" : "failed";
    record.result.reason = error instanceof Error ? error.message : String(error);
    useLogger("resize").error(record.result.reason);
  } finally {
    if (helperAttempted) {
      try {
        // Cleanup has its own bounded scope, so cancelling the caller does not strand a running helper.
        const deleted = await inCommandScope(new AbortController().signal, () => executor.run([
          "delete", "pod", helper, "--ignore-not-found", "--grace-period=1", "--wait=true", "--timeout=20s",
        ], { timeoutMs: 25_000 }));
        record.result.helperDeleted = deleted.ok;
        if (!deleted.ok) throw new Error(failReason(deleted));
      } catch (error) {
        record.result.status = "failed";
        record.result.reason = `${record.result.reason ?? ""}；辅助 Pod ${helper} 清理失败：${String(error)}`;
        useLogger("resize").error(record.result.reason);
        code = 1;
      }
    } else {
      record.result.helperDeleted = true;
    }
    persist();
  }
  return code;
}

export async function runResize(opts: ResizeCliOpts, context: CommandContext): Promise<number> {
  validateResizeOptions(opts);
  const config = await resolveKubernetesCommandConfig(opts, undefined, context);
  if (!config) return 130;
  const executor = createKubernetesExecutor(config);
  const access = context.kubernetes(executor).access;
  await enforceKubernetesAccess(access, {
    command: "doctor resize",
    needs: [
      { requirement: "required", rule: { verb: "get", resource: "pods" }, purpose: "确认目标实例和辅助 Pod" },
      { requirement: "required", rule: { verb: "create", resource: "pods/exec" }, purpose: "读取并调整目标内存 cgroup" },
      { requirement: "required", rule: { verb: "create", resource: "pods" }, purpose: "启动同节点辅助 Pod" },
      { requirement: "required", rule: { verb: "delete", resource: "pods" }, purpose: "清理辅助 Pod" },
    ],
  });
  const selected = await resolvePodTarget({
    config, executor, pod: opts.pod, container: opts.container,
    selectContainer: true, access, commandContext: context,
    selection: { candidateRole: "目标", purpose: "手动调整实例内存上限" },
  });
  if (!selected?.container) return 130;
  const target = await inspectMemoryResizeTarget(executor, selected.pod, selected.container);
  const keepalive = await infra.target.debugEngine.resolveTargetImageKeepalive(executor, target.pod, target.container);
  if (!keepalive) throw new Error("目标镜像缺少可用的 sleep / Python 常驻命令，无法准备 resize 辅助 Pod");
  return provisionMemoryResize({
    executor, target, keepalive: keepalive.command,
    requestedBytes: parseResizeMemory(opts.memory!), signal: context.signal,
    approve: resolveApprovalGate(opts), output: opts.output,
  });
}
