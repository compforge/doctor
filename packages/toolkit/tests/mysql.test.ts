import { expect, test } from "bun:test";
import type { Connection } from "mysql2/promise";
import { MysqlDatabase, type DatabaseTarget } from "../src/mysql";
import { DirectTransport, PodPythonTransport } from "../src/transport";
import { preparePodSql } from "../src/mysql/pod";

const target: DatabaseTarget = { host: "rds.example", port: 3306, database: "db", user: "reader", password: "stdin-only-password" };
const options = { connectTimeoutMs: 100, queryTimeoutMs: 500 };
function networkError(code = "ECONNREFUSED") { return Object.assign(new Error("unavailable"), { code }); }

test("host connection failure selects Pod without changing identity; subsequent queries reuse route", async () => {
  let connects = 0;
  const calls: { command: readonly string[]; stdin: string }[] = [];
  const routes: unknown[] = [];
  const pod = new PodPythonTransport(async (command, options) => {
    calls.push({ command, stdin: options.stdin });
    return '{"rows":[{"count":"9007199254740993"}]}';
  });
  const db = new MysqlDatabase([new DirectTransport(), pod], { ...options, onRoute: route => routes.push(route) }, async () => { connects++; throw networkError(); });
  expect(await db.queryOne(target, "SELECT ?", ["x' OR 1=1 --"])).toEqual({ count: "9007199254740993" });
  await db.query(target, "SELECT 1", []);
  expect(connects).toBe(1);
  expect(routes).toEqual([{ transport: "pod-python", reason: "ECONNREFUSED" }]);
  const request = JSON.parse(calls[0]!.stdin);
  expect(request.target).toEqual(target);
  expect(request.sql).toBe("SELECT %s");
  expect(request.values).toEqual(["x' OR 1=1 --"]);
  expect(calls[0]!.command.join(" ")).not.toContain(target.password);
  expect(calls[0]!.command.join(" ")).not.toContain("x' OR 1=1 --");
  await db.close();
});

test("SQL failure is not retried over another transport; failed native socket is discarded", async () => {
  let destroys = 0;
  let attempts = 0;
  const db = new MysqlDatabase([new DirectTransport(), new PodPythonTransport(async () => { throw new Error("unexpected Pod retry"); })], options, async () => {
    attempts++;
    return { execute: async () => { throw networkError("ECONNRESET"); }, destroy: () => { destroys++; } } as unknown as Connection;
  });
  await expect(db.query(target, "SELECT 1", [])).rejects.toThrow("unavailable");
  await expect(db.query(target, "SELECT 1", [])).rejects.toThrow("unavailable");
  expect(attempts).toBe(2);
  expect(destroys).toBe(2);
});

test("authentication errors and cancellation never trigger Pod fallback", async () => {
  const pod = new PodPythonTransport(async () => { throw new Error("unexpected Pod retry"); });
  const denied = new MysqlDatabase([new DirectTransport(), pod], options, async () => { throw networkError("ER_ACCESS_DENIED_ERROR"); });
  await expect(denied.query(target, "SELECT 1", [])).rejects.toThrow("unavailable");
  const controller = new AbortController();
  const cancelled = new MysqlDatabase([new DirectTransport(), pod], { ...options, signal: controller.signal }, async () => {
    controller.abort(new Error("cancelled"));
    throw networkError();
  });
  await expect(cancelled.query(target, "SELECT 1", [])).rejects.toThrow("cancelled");
});

test("Pod SQL keeps literals/comments and percent signs; protocol binding owns values", () => {
  expect(preparePodSql("SELECT '?', `?`, '100%', ? /* ? */ -- ?\n, ?", [1, null]))
    .toBe("SELECT '?', `?`, '100%%', %s /* ? */ -- ?\n, %s");
  expect(() => preparePodSql("SELECT ?", [])).toThrow("count");
  expect(() => preparePodSql("SELECT 1", [1])).toThrow("placeholder");
});

test("close destroys open sockets and drops cached sessions", async () => {
  let destroyed = 0;
  let opened = 0;
  const db = new MysqlDatabase([new DirectTransport()], options, async () => {
    opened++;
    return { execute: async () => [[{ ok: 1 }]], destroy: () => { destroyed++; } } as unknown as Connection;
  });
  await db.query(target, "SELECT 1", []);
  await db.close();
  await db.query(target, "SELECT 1", []);
  await db.close();
  expect(opened).toBe(2);
  expect(destroyed).toBe(2);
});
