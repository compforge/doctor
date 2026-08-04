import { describe, expect, test } from "bun:test";
import { runProbeStrategies } from "../src/collect/probe-strategy";
import type { ProbeStrategy } from "../src/collect/protocol";

type Strategy = ProbeStrategy<number, { base: number }, { seen: string[] }>;

describe("runProbeStrategies", () => {
  test("按注册顺序升级，并把此前尝试交给后续策略", async () => {
    const logs: string[] = [];
    const first: Strategy = {
      id: "first",
      run: async (ctx, facts, attempts) => {
        ctx.seen.push(`first:${attempts.length}`);
        return {
          status: "failed",
          decision: "continue",
          result: facts.base,
          reason: "当前路径不可用",
        };
      },
    };
    const second: Strategy = {
      id: "second",
      run: async (ctx, facts, attempts) => {
        ctx.seen.push(`second:${attempts[0]!.result}`);
        return { status: "succeeded", decision: "stop", result: facts.base + 1 };
      },
    };
    const never: Strategy = {
      id: "never",
      run: async () => ({ status: "succeeded", decision: "stop", result: 99 }),
    };
    const ctx = { seen: [] as string[] };

    const run = await runProbeStrategies(
      [first, second, never],
      ctx,
      { base: 7 },
      (line) => logs.push(line),
    );

    expect(ctx.seen).toEqual(["first:0", "second:7"]);
    expect(run.attempts.map((attempt) => attempt.strategyId)).toEqual(["first", "second"]);
    expect(run.final).toMatchObject({
      strategyId: "second",
      status: "succeeded",
      decision: "stop",
      result: 8,
    });
    expect(logs).toEqual([
      "[collect] 执行 ProbeStrategy：first…",
      "[collect] ProbeStrategy 完成：first（失败，继续升级）：当前路径不可用",
      "[collect] 执行 ProbeStrategy：second…",
      "[collect] ProbeStrategy 完成：second（成功，停止升级）",
    ]);
  });

  test("所有策略都要求继续时返回最后一次尝试", async () => {
    const strategy = (id: string, result: number): Strategy => ({
      id,
      run: async () => ({ status: "failed", decision: "continue", result }),
    });

    const run = await runProbeStrategies(
      [strategy("one", 1), strategy("two", 2)],
      { seen: [] },
      { base: 0 },
    );

    expect(run.final).toMatchObject({ strategyId: "two", result: 2 });
  });

  test("重复 id 在执行任何策略前报错", async () => {
    let ran = false;
    const strategy: Strategy = {
      id: "same",
      run: async () => {
        ran = true;
        return { status: "succeeded", decision: "stop", result: 1 };
      },
    };

    await expect(runProbeStrategies(
      [strategy, strategy],
      { seen: [] },
      { base: 0 },
    )).rejects.toThrow("duplicate probe strategy id: same");
    expect(ran).toBe(false);
  });

  test("runner 不吞策略异常，也不擅自执行下一条", async () => {
    let nextRan = false;
    const broken: Strategy = {
      id: "broken",
      run: async () => { throw new Error("boom"); },
    };
    const next: Strategy = {
      id: "next",
      run: async () => {
        nextRan = true;
        return { status: "succeeded", decision: "stop", result: 1 };
      },
    };

    await expect(runProbeStrategies(
      [broken, next],
      { seen: [] },
      { base: 0 },
    )).rejects.toThrow("boom");
    expect(nextRan).toBe(false);
  });
});
