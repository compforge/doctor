import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServiceCatalog } from "@compforge/doctor-plugin";
import { CommandContext, CommandStatus } from "../src/command";
import { dbCommand } from "../src/collect/db/command";
import { resolveDbRequest, tableScope, validateDbInput, type DbRequest } from "../src/collect/db/input";
import { discoverDatabases, selectDatabaseTarget, type DbProvider } from "../src/collect/db/discovery";
import { validateSql, quoteIdentifier } from "../src/collect/db/sql";
import * as providers from "../src/collect/db/providers";
import { canPrompt } from "../src/terminal/parameters";
import { createDoctorProgram } from "../src/app/main";
import { databaseDiscoverySummary } from "../src/collect/db/summary";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const request = (extra: Partial<DbRequest> = {}): DbRequest => ({
  input: {}, interactive: false, action: "query", sql: "SELECT 1", values: [], table: "messages",
  limits: { timeoutMs: 100, maxRows: 100, maxBytes: 4096 }, ...extra,
});
const result = (rows: Record<string, unknown>[], truncated = false) => ({ rows, columns: [], bytes: 10, truncated });
function provider(id = "primary"): DbProvider {
  return {
    id, dataSources: [{ id, description: `${id} records` }], source: "plugin", target: { host: id, port: 3306, database: "app", user: "reader", password: "never-output" },
    query: async () => result([{ database_name: "app", table_name: "messages" }]),
  };
}

describe("SQL policy", () => {
  for (const sql of [
    "SELECT 1", "SELECT id FROM app.messages WHERE id = ?",
    "WITH recent AS (SELECT id FROM messages LIMIT 10) SELECT COUNT(*) FROM recent",
    "SELECT m.id, COUNT(*) FROM messages m JOIN users u ON m.user_id = u.id GROUP BY m.id",
    "EXPLAIN SELECT * FROM messages", "SELECT 'O''Reilly: \"hello\"'", "SELECT '?' /* normal comment */;", "SELECT 1 /*metadata*/",
  ]) test(`accept ${sql}`, () => expect(() => validateSql(sql, sql.includes("= ?") ? 1 : 0)).not.toThrow());
  for (const sql of [
    "DELETE FROM messages", "UPDATE messages SET id = 1", "SELECT 1; SELECT 2", "START TRANSACTION",
    "EXPLAIN ANALYZE SELECT 1", "SELECT 1 FOR UPDATE", "SELECT * FROM t LOCK IN SHARE MODE",
    "SELECT 1 INTO OUTFILE '/tmp/x'", "SELECT @x := 1", "SELECT LOAD_FILE('/etc/passwd')",
    "SELECT SLEEP(1)", "SELECT GET_LOCK('lock', 1)", "SELECT app.COUNT(1)", "SELECT some_udf(1)",
    "SELECT 1 /*! INTO OUTFILE '/tmp/x' */", "SELECT /*+ MAX_EXECUTION_TIME(0) */ 1", "SELECT 1 --x\n + 2",
    "WITH x AS (SELECT SLEEP(1)) SELECT * FROM x", "SELECT 'back\\slash'", "SELECT 1 # comment",
  ]) test(`reject ${sql}`, () => expect(() => validateSql(sql, 0)).toThrow());
  test("bound values count and identifier quoting", () => {
    expect(() => validateSql("SELECT ?", 0)).toThrow("占位符");
    expect(() => validateSql("SELECT 1", 1)).toThrow("占位符");
    expect(quoteIdentifier("odd`table")).toBe("`odd``table`");
  });
});

test("database.table equals separate arguments and rejects conflicting scope", () => {
  expect(tableScope(undefined, "app.messages")).toEqual(tableScope("app", "messages"));
  expect(() => tableScope("other", "app.messages")).toThrow("冲突");
  expect(() => tableScope(undefined, "a.b.c")).toThrow();
});

test("mutually exclusive actions, input bounds and parameter shape fail before remote access", async () => {
  expect(() => validateDbInput({ execute: "SELECT 1", file: "query.sql" })).toThrow("互斥");
  expect(() => validateDbInput({ maxRows: "0" })).toThrow("--max-rows");
  await expect(resolveDbRequest({ execute: "SELECT ?", params: "{}" })).rejects.toThrow("数组");
  await expect(resolveDbRequest({ execute: "SELECT ?", params: '[{"key":1}]' })).rejects.toThrow("数组");
  await expect(resolveDbRequest({ interactive: false })).rejects.toThrow("操作");
});

test("SQL file preserves quotes, colons and newlines, but never authorizes batch scripts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-db-test-")); directories.push(dir);
  const path = join(dir, "query.sql");
  const sql = "SELECT 'O''Reilly: \"hello\"'\nFROM messages WHERE id = ?;\n";
  writeFileSync(path, sql);
  const actual = await resolveDbRequest({ file: path, params: '["id:123"]', interactive: false });
  expect(actual.sql).toBe(sql); expect(actual.values).toEqual(["id:123"]);
  writeFileSync(path, "SELECT 1; SELECT 2;");
  await expect(resolveDbRequest({ file: path })).rejects.toThrow("一条");
});

test("prompt availability follows TTY, internal policy and stdin ownership", async () => {
  const stdin = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdout = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const stderr = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
  try {
    for (const stream of [process.stdin, process.stdout, process.stderr]) Object.defineProperty(stream, "isTTY", { value: true, configurable: true });
    expect(canPrompt()).toBe(true);
    expect(canPrompt({ interactive: false })).toBe(false);
    expect(canPrompt({ stdinOwned: true })).toBe(false);
    expect(canPrompt({ interactive: false })).toBe(false);
    const actual = await resolveDbRequest({ service: "chat", table: "app.messages", execute: "SELECT 1" });
    expect(actual.action).toBe("query");
    expect(actual.sql).toBe("SELECT 1");
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    expect(canPrompt()).toBe(false);
    await expect(resolveDbRequest({})).rejects.toThrow("操作");
  } finally {
    for (const [stream, descriptor] of [[process.stdin, stdin], [process.stdout, stdout], [process.stderr, stderr]] as const) {
      if (descriptor) Object.defineProperty(stream, "isTTY", descriptor); else delete (stream as { isTTY?: boolean }).isTTY;
    }
  }
});

test("routing fails on ambiguity and on partial discovery, even with one remaining match", async () => {
  const first = provider();
  const rows = result([{ database_name: "app", table_name: "messages" }]);
  expect((await selectDatabaseTarget(request(), [{ provider: first, result: rows }])).provider).toBe(first);
  await expect(selectDatabaseTarget(request(), [{ provider: first, result: rows }, { provider: provider("second"), result: rows }])).rejects.toThrow("歧义");
  await expect(selectDatabaseTarget(request(), [{ provider: first, result: rows }, { provider: provider("second"), error: "denied" }])).rejects.toThrow("不完整");
  await expect(selectDatabaseTarget(request(), [{ provider: first, result: { ...rows, truncated: true } }])).rejects.toThrow("不完整");
});

test("discovery binds filters and sanitizes driver errors", async () => {
  const first = provider();
  const calls: unknown[] = [];
  first.query = async (sql, values) => { calls.push({ sql, values }); throw Object.assign(new Error("secret SELECT body"), { code: "ER_ACCESS_DENIED_ERROR" }); };
  const discovery = await discoverDatabases(request({ database: "app" }), [first]);
  expect(calls[0]).toMatchObject({ values: ["app", "messages"] });
  expect(JSON.stringify(discovery[0]?.error)).not.toContain("secret");
  expect(discovery[0]?.error).toContain("ER_ACCESS_DENIED_ERROR");
});

test("CLI exposes db flags and Distribution can set db defaults", () => {
  const program = createDoctorProgram({ name: "ascli", commands: "db", commandDefaults: { db: { format: "manifest" } } });
  const db = program.commands.find(command => command.name() === "db")!;
  expect(db.helpInformation()).toContain("Usage: ascli db");
  expect(db.helpInformation()).not.toContain("--no-interactive");
  expect(db.options.some(option => option.attributeName() === "interactive")).toBe(false);
  expect(db.helpInformation()).not.toContain("--store");
  expect(db.opts().format).toBe("manifest");
});

test("command preserves bounded results, status and sanitized target in Evidence", async () => {
  const first = provider();
  let calls = 0;
  first.query = async () => ++calls === 1
    ? result([{ database_name: "app", table_name: "messages" }]) : result([{ id: "message:1" }], true);
  const resolve = spyOn(providers, "resolveDbProviders").mockResolvedValue({ service: "chat", providers: [first], failures: [] });
  const context = new CommandContext({}, undefined, {
    plugin: {
      id: "test", version: "0.0.1", services: createServiceCatalog([
        {
          component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
          name: "chat",
          workloads: [],
          dataSources: [{ id: "primary", kind: "db", backend: "mysql", envPrefix: "DB" }]
        },
      ])
    }
  });
  const environment = spyOn(context, "ensureEnvironment").mockResolvedValue();
  try {
    const outcome = await dbCommand.run(context, { service: "chat", table: "app.messages", execute: "SELECT id FROM messages", interactive: false });
    expect(outcome.status).toBe(CommandStatus.Partial);
    expect(calls).toBe(2);
    const directory = outcome.artifacts[0]!.path; directories.push(directory);
    const manifest = readFileSync(join(directory, "collection.json"), "utf8");
    expect(manifest).not.toContain("never-output");
    expect(manifest).toContain('"database": "app"');
    expect(manifest).toContain('"status": "partial"');
    expect(JSON.parse(readFileSync(join(directory, "diagnosis.json"), "utf8")).results.at(-1).rows).toEqual([{ id: "message:1" }]);
  } finally { resolve.mockRestore(); environment.mockRestore(); await context.disposeClients(); }
});

test("database discovery preserves source descriptions in report, manifest and structured rows", async () => {
  const primary = provider();
  const runtime = provider("runtime");
  primary.query = async () => result([{ Database: "canonical" }]);
  runtime.query = async () => result([{ Database: "agent_runtime" }]);
  const resolve = spyOn(providers, "resolveDbProviders").mockResolvedValue({
    service: "api", providers: [primary, runtime],
    failures: [{ id: "archive", description: "Old records", reason: "unavailable" }]
  });
  const context = new CommandContext({}, undefined, {
    plugin: {
      id: "test", version: "0.0.1", services: createServiceCatalog([
        {
          name: "api",
          component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
          workloads: [],
          dataSources: [{ id: "primary", kind: "db", backend: "mysql", envPrefix: "DB" }]
        },
      ])
    }
  });
  const environment = spyOn(context, "ensureEnvironment").mockResolvedValue();
  try {
    const outcome = await dbCommand.run(context, { service: "api", showDatabases: true, interactive: false });
    expect(outcome.status).toBe(CommandStatus.Partial);
    const directory = outcome.artifacts[0]!.path; directories.push(directory);
    const summary = readFileSync(join(directory, "summary.md"), "utf8");
    expect(summary).toContain("| primary | canonical | primary records | ok |");
    expect(summary).toContain("| runtime | agent_runtime | runtime records | ok |");
    expect(summary).toContain("| archive | — | Old records | unavailable |");
    const diagnosis = JSON.parse(readFileSync(join(directory, "diagnosis.json"), "utf8"));
    expect(diagnosis.results[1]).toMatchObject({ target: "runtime", dataSources: [{ id: "runtime", description: "runtime records" }], rows: [{ Database: "agent_runtime" }] });
    const manifest = readFileSync(join(directory, "collection.json"), "utf8");
    expect(manifest).toContain("runtime records");
    expect(manifest).toContain("Old records");
    expect(manifest).not.toContain("never-output");
  } finally { resolve.mockRestore(); environment.mockRestore(); await context.disposeClients(); }
});

test("discovery summary handles omitted descriptions, empty results and truncation", () => {
  const first = provider();
  first.dataSources = [{ id: "primary" }, { id: "alias", description: "notes | line\nbreak" }];
  const summary = databaseDiscoverySummary([{ provider: first, result: result([{ Database: "app" }], true) }], []);
  expect(summary).toContain("| primary | app | — | partial");
  expect(summary).toContain("notes \\| line break");
  expect(databaseDiscoverySummary([{ provider: first, result: result([]) }], [])).toContain("未发现可见数据库");
});
