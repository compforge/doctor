import { expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { ConcurrencyPool } from "../src/concurrency";

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

test("slots preserve caller context and survive queued cancellation and worker failures", async () => {
  const pool = new ConcurrencyPool(1);
  const local = new AsyncLocalStorage<string>();
  const entered = latch();
  const finish = latch();
  const order: string[] = [];
  const first = local.run("first", () => pool.run(async () => {
    entered.release();
    await finish.promise;
    order.push(local.getStore()!);
    throw new Error("worker failed");
  }).catch((error) => error.message));
  await entered.promise;
  const cancelled = new AbortController();
  const skipped = pool.run(async () => { throw new Error("must not start"); }, cancelled.signal).catch((error) => error.message);
  const second = local.run("second", () => pool.run(async () => { order.push(local.getStore()!); }));
  cancelled.abort(new Error("cancel queued"));
  expect(await skipped).toBe("cancel queued");
  finish.release();
  expect(await first).toBe("worker failed");
  await second;
  expect(order).toEqual(["first", "second"]);
  expect(await pool.run(async () => 42)).toBe(42);
});
