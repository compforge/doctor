import { expect, test } from "bun:test";
import { Engine } from "@compforge/perf-harness";
import { bindService } from "@compforge/doctor-plugin";
import { CommandContext } from "../src/command";
import { PerfProgress, formatPerfSummary } from "../src/perf/progress";

const service = bindService({ name: "fixture", workloads: [],
  component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixture/perf" } },
}, { name: "test" });

test("Ctrl+C stops new requests, drains inflight calls and keeps repeated interrupts graceful", async () => {
  const context = new CommandContext({});
  const messages: string[] = [];
  const progress = new PerfProgress(text => messages.push(text));
  let calls = 0;
  let release!: () => void;
  const response = new Promise<void>(resolve => { release = resolve; });
  try {
    const result = new Engine({ service, signal: context.signal, stopSignal: progress.stop.signal,
      loads: [{ request_rate: 1000, max_inflight: 1, hold_s: 60, cooldown_timeout_s: 1 }],
      onArmStart: () => progress.start(context),
      ...progress.observe({ runner: { name: "fixture", fire: async ({ signal }) => {
        calls++;
        context.interrupt(new Error("SIGINT"));
        context.interrupt(new Error("SIGINT again"));
        expect(signal.aborted).toBe(false);
        progress.print();
        await response;
        return { status: 200, duration_ms: 10 };
      } }, judge: () => ({ code: "success" }) }),
    }).run();
    // Allow the scheduler to enter drain with a request still pending.
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(calls).toBe(1);
    expect(context.signal.aborted).toBe(false);
    expect(messages.join("")).toContain("等待 1 个在途请求");
    expect(messages.join("")).toContain("已发出 1，已结束 0，在途 1");
    release();
    const run = await result;
    expect(run.status).toBe("completed");
    expect(run.executions[0]!.stop).toMatchObject({ reason: "manual", interrupted: 0 });
    expect(run.executions[0]!.requests).toHaveLength(1);
    expect(formatPerfSummary(run, ["missing metrics"])).toContain("结束原因=manual");
    expect(formatPerfSummary(run)).toContain("完成=1，成功=1，中断=0");
    progress.requestsFinished();
    context.interrupt(new Error("during metrics"));
    expect(context.signal.aborted).toBe(false);
  } finally { release(); progress.dispose(); await context.disposeClients(); }
  const cancelled = new Error("outside observation");
  context.interrupt(cancelled);
  expect(context.signal.reason).toBe(cancelled);
});

test("external cancellation still aborts perf requests even with graceful interrupt handling", async () => {
  const controller = new AbortController();
  const context = new CommandContext({}, undefined, { signal: controller.signal });
  const progress = new PerfProgress(() => {});
  try {
    progress.start(context);
    const reason = new Error("external deadline");
    controller.abort(reason);
    expect(context.signal.reason).toBe(reason);
    expect(progress.stop.signal.aborted).toBe(false);
  } finally { progress.dispose(); await context.disposeClients(); }
});

// @case A real SIGINT must reach Perf's stop signal without cancelling finalization or dropping the bundle.
test("CLI SIGINT preserves normal exit and delivers a manual-stop perf bundle", async () => {
  const { mkdtempSync, rmSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "perf-interrupt-"));
  const archive = join(directory, "perf.tar.gz");
  const child = Bun.spawn([process.execPath, new URL("fixtures/perf-interrupt.ts", import.meta.url).pathname,
    join(directory, "missing-config.yaml"), archive], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let stderr = "", signalled = false;
  const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try {
    const read = (async () => {
      for await (const chunk of child.stderr) {
        stderr += Buffer.from(chunk).toString();
        if (!signalled && stderr.includes("[perf] 执行中")) {
          // Enter is deliberately inert: only SIGINT requests a normal stop.
          child.stdin.write("\n");
          await new Promise(resolve => setTimeout(resolve, 30));
          expect(child.exitCode).toBeNull();
          signalled = true;
          child.kill("SIGINT");
        }
      }
    })();
    const status = await child.exited;
    await read;
    expect({ status, signalled, output: stderr.includes("[perf] 本轮结果") }).toEqual({ status: 0, signalled: true, output: true });
    expect(existsSync(archive)).toBe(true);
    expect(stderr).not.toContain("回车结束");
    const entries = Bun.spawnSync(["tar", "-tzf", archive]).stdout.toString().split("\n");
    const model = entries.find(path => path.endsWith("/run.json"))!;
    const run = JSON.parse(Bun.spawnSync(["tar", "-xOf", archive, model]).stdout.toString());
    expect(run.status).toBe("completed");
    expect(run.executions[0].stop).toMatchObject({ reason: "manual", interrupted: 0 });
  } finally { clearTimeout(timeout); if (child.exitCode === null) child.kill("SIGKILL"); rmSync(directory, { recursive: true, force: true }); }
}, 20_000);
