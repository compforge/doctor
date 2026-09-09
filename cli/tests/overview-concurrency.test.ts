import { expect, test } from "bun:test";
import { CommandContext, CommandStatus, defineCommand } from "../src/command";
import { onCommandDispose } from "../src/command/execution-scope";
import type { CollectInput, CollectOutput } from "../src/collect/composite";
import { collectOverviewSamples } from "../src/overview/collect";
import { overviewCollectConcurrency } from "../src/overview/options";
import { runPodLogCapturePlan, DEFAULT_POD_LOG_CAPTURE_POLICY } from "../src/infra/k8s/log-capture-plan";
import type { KubernetesPodLogAccess } from "../src/infra/k8s/pod-log";

const kinds: CollectInput["kinds"] = ["data", "trace", "log"];
const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

test("all collects share eight log slots regardless of collect concurrency", async () => {
  for (const concurrency of [2, 5]) {
    const context = new CommandContext({}, { name: "test", configPath: "", pluginConfig: {}, value: { readonly: true, log: { concurrency: 8 } } });
    let collecting = 0, peakCollect = 0, logging = 0, peakLog = 0, captures = 0;
    const disposed: string[] = [];
    const access: KubernetesPodLogAccess = {
      clientVersion: async () => { throw new Error("unused"); },
      listServicePods: async () => { throw new Error("unused"); },
      collectPodLogs: async () => {
        logging++; captures++; peakLog = Math.max(peakLog, logging);
        await delay();
        logging--;
        return { ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false,
          command: [], captureStatus: "complete", bytesRead: 1, attempts: 1 };
      },
    };
    const command = defineCommand<CollectInput, CollectOutput>({
      name: "test collect",
      run: async (ctx, input) => {
        const id = input.bizIds[0]!;
        collecting++; peakCollect = Math.max(peakCollect, collecting);
        ctx.artifacts.add({ command: "log", path: `/tmp/${id}` });
        onCommandDispose(() => { disposed.push(id); collecting--; });
        const plan = Array.from({ length: 16 }, (_, i) => ({ target: i, request: { pod: `${id}-${i}`, container: "app", previous: i % 2 === 0 } }));
        const result = await runPodLogCapturePlan(access, plan,
          { ...DEFAULT_POD_LOG_CAPTURE_POLICY, concurrency: ctx.limits.podLogs.concurrency }, ctx.limits.podLogs, ctx.signal);
        expect(result.map((item) => item.target)).toEqual(plan.map((item) => item.target));
        expect(ctx.artifacts.list().map((item) => item.path)).toEqual([`/tmp/${id}`]);
        return { status: id === "b" ? CommandStatus.Failed : CommandStatus.Ok, output: { steps: [] }, artifacts: ctx.artifacts.list() };
      },
    });
    const result = await collectOverviewSamples(context, ["a", "b", "c", "d", "e"], { kinds }, concurrency, command.run);
    expect(peakCollect).toBe(concurrency);
    expect(peakLog).toBe(8);
    expect(logging).toBe(0);
    expect(captures).toBe(80);
    expect(disposed).toHaveLength(5);
    expect(result.status).toBe(CommandStatus.Partial);
    expect(result.artifacts.map((item) => item.path)).toEqual(["/tmp/a", "/tmp/b", "/tmp/c", "/tmp/d", "/tmp/e"]);
  }
});

test("cancelling overview drains started collects and never starts queued ids", async () => {
  const context = new CommandContext({});
  const started: string[] = [], disposed: string[] = [];
  let ready!: () => void;
  const bothStarted = new Promise<void>((resolve) => { ready = resolve; });
  const command = defineCommand<CollectInput, CollectOutput>({
    name: "test cancellable collect",
    run: async (ctx, input) => {
      const id = input.bizIds[0]!;
      started.push(id);
      ctx.artifacts.add({ command: "log", path: `/tmp/partial-${id}` });
      onCommandDispose(() => { disposed.push(id); });
      if (started.length === 2) ready();
      await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
      return { status: CommandStatus.Cancelled, artifacts: ctx.artifacts.list() };
    },
  });
  const pending = collectOverviewSamples(context, ["a", "b", "c", "d"], { kinds }, 2, command.run);
  await bothStarted;
  context.cancel();
  const result = await pending;
  expect(started).toEqual(["a", "b"]);
  expect(disposed.sort()).toEqual(["a", "b"]);
  expect(result.status).toBe(CommandStatus.Cancelled);
  expect(result.artifacts).toHaveLength(2);
});

test("defaults and overrides keep collect and log limits independent", () => {
  expect(new CommandContext({}).limits.podLogs.concurrency).toBe(4);
  expect(overviewCollectConcurrency()).toBe(2);
  expect(overviewCollectConcurrency(undefined, 3)).toBe(3);
  expect(overviewCollectConcurrency(5, 3)).toBe(5);
  for (const n of [0, -1, 1.5, NaN, Infinity]) expect(() => overviewCollectConcurrency(n)).toThrow("正整数");
});
