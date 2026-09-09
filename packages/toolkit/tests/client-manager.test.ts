import { expect, test } from "bun:test";
import { ClientManager } from "../src/client-manager";
import type { Client } from "../src/client";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test("same identity joins initialization; queries remain independent; dependencies close last", async () => {
  const clients = new ClientManager();
  const order: string[] = [];
  let starts = 0;
  const ready = gate();
  await clients.get({ key: "k8s", createClient: () => ({ initialize: async () => {}, dispose: async () => { order.push("k8s"); } }) });
  const source = { key: "db", createClient: () => ({
    initialize: async () => { starts++; await ready.promise; },
    query: async (id: string) => id,
    dispose: async () => { order.push("db"); },
  }) };
  const first = clients.get(source);
  const second = clients.get({ ...source });
  ready.release();
  const [a, b] = await Promise.all([first, second]);
  expect(a).toBe(b);
  expect(starts).toBe(1);
  expect(await Promise.all([a.query("a"), b.query("b")])).toEqual(["a", "b"]);
  expect(clients.dispose()).toBe(clients.dispose());
  await clients.dispose();
  expect(order).toEqual(["db", "k8s"]);
  expect(() => clients.get(source)).toThrow("disposed");
});

test("failed initialization cleans before retry and doesn't close borrowed dependencies", async () => {
  const clients = new ClientManager();
  const order: string[] = [];
  await clients.get({ key: "k8s", createClient: () => ({ initialize: async () => {}, dispose: async () => { order.push("k8s"); } }) });
  await expect(clients.get({ key: "db", createClient: () => ({
    initialize: async () => { throw new Error("unavailable"); },
    dispose: async () => { order.push("partial"); },
  }) })).rejects.toThrow("unavailable");
  await clients.get({ key: "db", createClient: () => ({ initialize: async () => { order.push("retry"); }, dispose: async () => { order.push("db"); } }) });
  expect(order).toEqual(["partial", "retry"]);
  await clients.dispose();
  expect(order).toEqual(["partial", "retry", "db", "k8s"]);
});

test("dispose waits for late initialization and does not leak its client", async () => {
  const clients = new ClientManager();
  const started = gate();
  const ready = gate();
  let closed = 0;
  const pending = clients.get({ key: "db", createClient: () => ({
    initialize: async () => { started.release(); await ready.promise; },
    dispose: async () => { closed++; },
  }) }).catch(error => error);
  await started.promise;
  const closing = clients.dispose();
  ready.release();
  expect(await pending).toBeInstanceOf(Error);
  await closing;
  expect(closed).toBe(1);
});

test("dispose before construction avoids external work; cleanup failures don't block other clients", async () => {
  const clients = new ClientManager();
  let started = false;
  const pending = clients.get({ key: "new", createClient: (): Client => {
    started = true;
    return { initialize: async () => {}, dispose: async () => {} };
  } }).catch(error => error);
  await clients.dispose();
  expect(await pending).toBeInstanceOf(Error);
  expect(started).toBe(false);
  const other = new ClientManager();
  const closed: string[] = [];
  for (const key of ["a", "b"]) await other.get({ key, createClient: () => ({
    initialize: async () => {}, dispose: async () => { closed.push(key); throw new Error(key); },
  }) });
  await expect(other.dispose()).rejects.toThrow("Client cleanup failed");
  expect(closed).toEqual(["b", "a"]);
});


test("a concurrent retry waits for failed initialization cleanup", async () => {
  const clients = new ClientManager();
  const cleaning = gate();
  const cleaned = gate();
  let starts = 0;
  const source = { key: "db", createClient: () => ({
    initialize: async () => { starts++; throw new Error("offline"); },
    dispose: async () => { cleaning.release(); await cleaned.promise; },
  }) };
  const first = clients.get(source);
  const failure = first.catch(error => error);
  await cleaning.promise;
  expect(clients.get(source)).toBe(first);
  expect(starts).toBe(1);
  cleaned.release();
  expect(await failure).toBeInstanceOf(Error);
  await expect(clients.get(source)).rejects.toThrow("offline");
  expect(starts).toBe(2);
  await clients.dispose();
});
