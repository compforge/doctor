import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceBundle } from "../src/collect/evidence";
import type { InspectionMode } from "../src/collect/inspection";
import {
  authorize,
  decline,
  type ApprovalContext,
  type Operation,
} from "../src/collect/operation";
import {
  approveAll,
  type ApprovalDecision,
  type ApprovalGate,
  type ApprovalRequest,
} from "../src/command/approval";
import {
  isApprovalAnswer,
  resolveApprovalGate,
} from "../src/terminal/approval";

const OPERATION: Operation = {
  id: "packet-capture",
  risk: "disrupt",
  title: "启动抓包",
  target: "pod/app-0 container/app",
  impact: ["创建临时抓包进程"],
  steps: [{ id: "tcpdump", title: "抓包", risk: "disrupt" }],
};

const REQUEST: ApprovalRequest = {
  id: OPERATION.id,
  risk: OPERATION.risk,
  title: OPERATION.title,
  target: OPERATION.target,
  impact: OPERATION.impact,
};

function makeContext(overrides: {
  mode?: InspectionMode;
  gate?: ApprovalGate;
} = {}): ApprovalContext & { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "doctor-approval-"));
  return {
    dir,
    mode: overrides.mode ?? "disrupt",
    bundle: new EvidenceBundle(dir),
    approvalGate: overrides.gate ?? approveAll,
    approvals: new Map<string, ApprovalDecision>(),
  };
}

describe("collect approval", () => {
  test("[y/N] 接受 y/yes，默认拒绝", () => {
    expect(isApprovalAnswer("y")).toBe(true);
    expect(isApprovalAnswer("yes")).toBe(true);
    expect(isApprovalAnswer(" YES ")).toBe(true);
    expect(isApprovalAnswer("Y")).toBe(true);
    expect(isApprovalAnswer("")).toBe(false);
    expect(isApprovalAnswer("yes please")).toBe(false);
    expect(isApprovalAnswer("no")).toBe(false);
  });

  test("-y/--yes 解析为 assume-yes gate", async () => {
    expect(await resolveApprovalGate({ yes: true })(REQUEST)).toEqual({
      approved: true,
      source: "assume-yes",
    });
  });

  test("授权来源、风险、目标与影响写入 Evidence Bundle", async () => {
    const ctx = makeContext();
    expect(await authorize(ctx, OPERATION, "验证抓包链路")).toEqual({ approved: true });
    expect(ctx.bundle.getSteps()[0]).toMatchObject({
      id: "approval-packet-capture",
      risk: "observe",
      status: "ok",
    });
    const raw = readFileSync(join(ctx.dir, ctx.bundle.getSteps()[0].raw_file!), "utf-8");
    expect(raw).toContain("approval_source=assume-yes");
    expect(raw).toContain("operation=packet-capture");
    expect(raw).toContain("risk=disrupt");
    expect(raw).toContain("target=pod/app-0 container/app");
    expect(raw).toContain("purpose=验证抓包链路");
    expect(raw).toContain("impact=创建临时抓包进程");
  });

  test("risk 高于 mode 时不询问，直接把 operation 的步骤记成 skipped", async () => {
    let asked = 0;
    const ctx = makeContext({
      mode: "overhead",
      gate: async () => {
        asked += 1;
        return { approved: true, source: "prompt" };
      },
    });
    const result = await authorize(ctx, OPERATION);
    expect(result).toEqual({
      approved: false,
      reason: "mode=overhead 不允许 disrupt 操作：启动抓包",
    });
    expect(asked).toBe(0);
    expect(ctx.bundle.getSteps()).toEqual([
      expect.objectContaining({
        id: "tcpdump",
        status: "skipped",
        reason: "mode=overhead 不允许 disrupt 操作：启动抓包",
      }),
    ]);
  });

  test("拒绝时 operation 自身步骤记成 skipped", async () => {
    const ctx = makeContext({ gate: async () => ({ approved: false, source: "prompt" }) });
    const result = await authorize(ctx, OPERATION);
    expect(result.approved).toBe(false);
    expect(ctx.bundle.getSteps()).toEqual([
      expect.objectContaining({ id: "approval-packet-capture", status: "skipped" }),
      expect.objectContaining({ id: "tcpdump", status: "skipped" }),
    ]);
  });

  test("同一 operation+target 一次采集内只问一次；同意与拒绝都缓存", async () => {
    for (const approved of [true, false]) {
      let asked = 0;
      const ctx = makeContext({
        gate: async () => {
          asked += 1;
          return { approved, source: "prompt" };
        },
      });
      expect((await authorize(ctx, OPERATION)).approved).toBe(approved);
      expect((await authorize(ctx, OPERATION)).approved).toBe(approved);
      expect(asked).toBe(1);
      // 缓存命中不重复记账：首次调用已经把 steps 标好了
      expect(ctx.bundle.getSteps().filter((step) => step.id === "tcpdump")).toHaveLength(
        approved ? 0 : 1,
      );
    }
  });

  test("同一 operation 打到不同 target 分别确认", async () => {
    let asked = 0;
    const ctx = makeContext({
      gate: async () => {
        asked += 1;
        return { approved: true, source: "prompt" };
      },
    });
    await authorize(ctx, OPERATION);
    await authorize(ctx, { ...OPERATION, target: "pod/app-1 container/app" });
    expect(asked).toBe(2);
  });

  test("gate 抛错按拒绝处理，且归因是『确认环节出错』而不是用户拒绝", async () => {
    const ctx = makeContext({
      gate: async () => {
        throw new Error("tty gone");
      },
    });
    expect(await authorize(ctx, OPERATION)).toEqual({
      approved: false,
      reason: "确认环节出错，已取消该操作",
    });
    const raw = readFileSync(join(ctx.dir, ctx.bundle.getSteps()[0].raw_file!), "utf-8");
    expect(raw).toContain("approval_source=gate-error");
  });

  test("gate 拿得到内部 risk，用户措辞不暴露风险枚举", async () => {
    const seen: ApprovalRequest[] = [];
    const ctx = makeContext({
      gate: async (request) => {
        seen.push(request);
        return { approved: true, source: "prompt" };
      },
    });
    await authorize(ctx, { ...OPERATION, risk: "overhead", title: "发送诊断信号" });
    expect(seen[0]!.risk).toBe("overhead");
  });

  test("operation 被拒时不暴露内部风险枚举", async () => {
    const ctx = makeContext({ gate: async () => ({ approved: false, source: "prompt" }) });
    const result = await authorize(ctx, { ...OPERATION, risk: "overhead" });
    expect(result).toEqual({
      approved: false,
      reason: "用户未确认，已取消该操作",
    });
  });

  test("非交互终端与用户拒绝在证据包里可区分", async () => {
    // 关键区别：非交互时用户根本没被问到，记成"用户未确认"是在证据包里写假话。
    const ctx = makeContext({ gate: async () => ({ approved: false, source: "non-interactive" }) });
    const result = await authorize(ctx, OPERATION);
    expect(result).toEqual({
      approved: false,
      reason: "非交互终端无法取得确认（可用 -y/--yes 预先批准），已取消该操作",
    });
    expect(ctx.bundle.getSteps()).toEqual([
      expect.objectContaining({
        id: "approval-packet-capture",
        status: "skipped",
        reason: "非交互终端无法取得确认（可用 -y/--yes 预先批准），已取消该操作",
      }),
      expect.objectContaining({ id: "tcpdump", status: "skipped" }),
    ]);
    const raw = readFileSync(join(ctx.dir, ctx.bundle.getSteps()[0].raw_file!), "utf-8");
    expect(raw).toContain("approval_source=non-interactive");
  });

  test("缓存复用保持原始归因，不把 gate 出错说成用户拒绝", async () => {
    let asked = 0;
    const ctx = makeContext({
      gate: async () => {
        asked += 1;
        throw new Error("tty gone");
      },
    });
    const denied = { approved: false, reason: "确认环节出错，已取消该操作" };
    expect(await authorize(ctx, OPERATION)).toEqual(denied);
    expect(await authorize(ctx, OPERATION)).toEqual(denied);
    expect(asked).toBe(1);
  });

  test("decline 供领域原因直接记账，不经过 gate", () => {
    const ctx = makeContext();
    decline(ctx, OPERATION, "kernel ptrace_scope=3");
    expect(ctx.bundle.getSteps()).toEqual([
      expect.objectContaining({ id: "tcpdump", status: "skipped", reason: "kernel ptrace_scope=3" }),
    ]);
  });
});
