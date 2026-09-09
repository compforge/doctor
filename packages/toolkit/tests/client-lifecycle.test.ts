import { expect, test } from "bun:test";
import { MysqlClient } from "../src/mysql";
import { RedisClient, RedisAccess } from "../src/redis";
import { OpenSearchClient } from "../src/opensearch";
import { KubernetesClient } from "../src/kubernetes/client";
import { DirectTransport, PodPythonTransport } from "../src/transport";
import { dataSourceKey } from "../src/datasource";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
const target = { host: "db", port: 3306, database: "db", user: "reader", password: "secret" };

test("protocol clients dispose during resolution without starting a late transport", async () => {
  for (const kind of ["mysql", "redis", "opensearch"] as const) {
    const resolving = gate();
    let connections = 0;
    const transport = { kind: "tcp" as const, name: "fake", connect: async () => { connections++; return { host: "localhost", port: 1 }; } };
    const resolve = async () => { await resolving.promise; };
    const client = kind === "mysql"
      ? new MysqlClient({ resolve: async () => { await resolve(); return target; }, transports: [transport] }, { connectTimeoutMs: 100, queryTimeoutMs: 100 })
      : kind === "redis"
        ? new RedisClient({ resolve: async () => { await resolve(); return { endpoints: [], database: 0, useSsl: false, timeoutMs: 100 }; }, transports: [transport] })
        : new OpenSearchClient({ resolve: async () => { await resolve(); return { node: "http://search:9200", auth: {} }; }, transports: [transport] });
    const initializing = client.initialize().catch(error => error);
    const closing = client.dispose();
    expect(client.dispose()).toBe(closing);
    resolving.release();
    expect(await initializing).toBeInstanceOf(Error);
    await closing;
    expect(connections).toBe(0);
    expect(() => client.initialize()).toThrow("disposed");
  }
});

test("MySQL initialization shares preparation; retained database cannot reopen after dispose", async () => {
  let resolves = 0;
  let queries = 0;
  const client = new MysqlClient({ resolve: async () => { resolves++; return target; }, transports: [
    new PodPythonTransport(async () => { queries++; return '{"rows":[]}'; }),
  ] }, { connectTimeoutMs: 100, queryTimeoutMs: 100 });
  await Promise.all([client.initialize(), client.initialize()]);
  const database = client.database;
  await database.query(target, "SELECT 1", []);
  await client.dispose();
  await expect(database.query(target, "SELECT 1", [])).rejects.toThrow("disposed");
  expect(resolves).toBe(1);
  expect(queries).toBe(1);
});

test("Redis close waits for pending connections and is terminal and idempotent", async () => {
  const opening = gate();
  let closes = 0;
  const access = new RedisAccess(new DirectTransport(), { useSsl: false, timeoutMs: 100 }, async endpoint => {
    await opening.promise;
    return { endpoint, isReady: true, close: () => { closes++; }, ping: async () => "PONG", info: async () => ({}),
      dbSize: async () => 0, command: async () => null, pipeline: async () => [], scan: async () => ({ cursor: "0", keys: [] }) };
  });
  const pending = access.connection({ host: "redis", port: 6379 }, 0);
  await Promise.resolve();
  const closing = access.close();
  expect(access.close()).toBe(closing);
  opening.release();
  await pending;
  await closing;
  expect(closes).toBe(1);
  await expect(access.connection({ host: "redis", port: 6379 }, 0)).rejects.toThrow("closed");
});

test("Kubernetes dispose cancels active operations and waits for them", async () => {
  const started = gate();
  let signal: AbortSignal | undefined;
  const client = new KubernetesClient({ namespace: "test" }, undefined, {
    run: async (command, options) => {
      signal = options?.signal;
      started.release();
      await new Promise<void>(resolve => signal!.addEventListener("abort", () => resolve(), { once: true }));
      return { ok: false, exitCode: 1, stdout: "", stderr: "cancelled", command, durationMs: 0, timedOut: false };
    }, exec: async () => { throw new Error("unexpected"); },
  });
  await client.initialize();
  const pending = client.run("test", ["get", "pods"]);
  await started.promise;
  const closing = client.dispose();
  expect(client.dispose()).toBe(closing);
  await closing;
  await pending;
  expect(signal?.aborted).toBe(true);
  expect(() => client.run("test", ["get", "pods"])).toThrow("disposed");
});

test("datasource identity is stable, credential-sensitive, and hides credentials", () => {
  const key = dataSourceKey("mysql", { host: "db", password: "secret" });
  expect(key).toBe(dataSourceKey("mysql", { password: "secret", host: "db" }));
  expect(key).not.toBe(dataSourceKey("mysql", { host: "db", password: "other" }));
  expect(key).not.toContain("secret");
});
