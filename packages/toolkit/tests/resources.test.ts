import { expect, test } from "bun:test";
import { ResourceScope, type ResourceLifetime } from "../src/resources";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test("concurrent acquisition shares initialization and closes dependencies in reverse order once", async () => {
  const scope = new ResourceScope();
  const ready = gate();
  const order: string[] = [];
  let starts = 0;
  const create = async (lifetime: ResourceLifetime) => {
    starts++;
    lifetime.onDispose(() => { order.push("transport"); });
    await ready.promise;
    lifetime.onDispose(() => { order.push("client"); });
    return { query: (value: string) => value };
  };
  const a = scope.acquire("database", create);
  const b = scope.acquire("database", create);
  ready.release();
  const [first, second] = await Promise.all([a, b]);
  expect(starts).toBe(1);
  expect(first).toBe(second);
  expect(first.query("a")).toBe("a");
  expect(second.query("b")).toBe("b");
  await Promise.all([scope.dispose(), scope.dispose()]);
  expect(order).toEqual(["client", "transport"]);
  expect(() => scope.acquire("new", create)).toThrow("disposed");
});

test("failed initialization cleans partial resources before another attempt", async () => {
  const scope = new ResourceScope();
  const order: string[] = [];
  const first = scope.acquire("database", async lifetime => {
    lifetime.onDispose(() => { order.push("closed"); });
    throw new Error("unavailable");
  });
  await expect(first).rejects.toThrow("unavailable");
  const value = await scope.acquire("database", async () => { order.push("retry"); return 1; });
  expect(value).toBe(1);
  expect(order).toEqual(["closed", "retry"]);
  await scope.dispose();
});

test("root cancellation drains in-flight initialization and closes late resources", async () => {
  const controller = new AbortController();
  const scope = new ResourceScope(controller.signal);
  const started = gate();
  const ready = gate();
  let closed = 0;
  const pending = scope.acquire("database", async lifetime => {
    started.release();
    await ready.promise;
    lifetime.onDispose(() => { closed++; });
    return 1;
  });
  const outcome = pending.catch(error => error);
  await started.promise;
  controller.abort(new Error("cancelled"));
  const disposal = scope.dispose();
  ready.release();
  expect(await outcome).toBeInstanceOf(Error);
  await disposal;
  expect(closed).toBe(1);
});

test("cleanup continues after failures and reports all of them", async () => {
  const scope = new ResourceScope();
  const calls: string[] = [];
  await scope.acquire("db", async lifetime => {
    lifetime.onDispose(() => { calls.push("transport"); throw new Error("transport failed"); });
    lifetime.onDispose(() => { calls.push("client"); throw new Error("client failed"); });
    return 1;
  });
  await expect(scope.dispose()).rejects.toThrow("Resource cleanup failed");
  expect(calls).toEqual(["client", "transport"]);
});

test("disposal before factory dispatch never starts external initialization", async () => {
  const scope = new ResourceScope();
  let started = false;
  const pending = scope.acquire("db", async () => { started = true; return 1; });
  const outcome = pending.catch(error => error);
  await scope.dispose();
  expect((await outcome).message).toContain("disposed");
  expect(started).toBe(false);
});
