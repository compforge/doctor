import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createServiceCatalog } from "@compforge/doctor-plugin";
import type { DatabaseQueryResult } from "@compforge/harness-toolbox/mysql";
import { CommandContext, CommandStatus } from "../src/command";
import { createDoctorProgram } from "../src/app/main";
import { dbCommand } from "../src/collect/db/command";
import type { DbInput } from "../src/collect/db/input";
import type { DbProvider } from "../src/collect/db/discovery";
import * as providers from "../src/collect/db/providers";
import { databaseSummary } from "../src/collect/db/summary";
import { finalizeResult } from "./report-fixture";
import { withLogger } from "../src/terminal/log";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const result = (rows: Record<string, unknown>[], truncation?: "rows" | "bytes"): DatabaseQueryResult => ({
  rows, columns: Object.keys(rows[0] ?? {}), bytes: 10, truncated: !!truncation, truncation,
});

function provider(id = "primary"): DbProvider {
  return { id, dataSources: [{ id }], source: "plugin",
    target: { host: id, port: 3306, database: "default_db", user: "reader", password: "never-output" },
    query: async () => result([{ database_name: "app", table_name: "messages" }]),
  };
}
function context(options: { format?: string; output?: string } = { format: "summary" }) {
  return new CommandContext({}, undefined, { ...options, plugin: {
    id: "test", version: "0.0.1", services: createServiceCatalog([{
      name: "api", component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
      workloads: [], dataSources: [{ id: "primary", kind: "db", backend: "mysql", envPrefix: "DB" }],
    }]),
  } });
}

test("DB accepts summary as a CLI and distribution format", () => {
  const program = createDoctorProgram({ name: "doctor", commands: "db", commandDefaults: { db: { format: "summary" } } });
  const db = program.commands.find(command => command.name() === "db")!;
  expect(db.opts().format).toBe("summary");
  expect(db.options.find(option => option.attributeName() === "format")!.argChoices).toContain("summary");
});

test("DB rejects summary output paths before environment access", async () => {
  const ctx = context({ format: "summary", output: "report.md" });
  const environment = spyOn(ctx, "ensureEnvironment").mockResolvedValue();
  try {
    const outcome = await dbCommand.run(ctx, { service: "api", execute: "SELECT 1", interactive: false });
    expect(outcome.status).toBe(CommandStatus.Failed);
    expect(outcome).toMatchObject({ reason: expect.stringContaining("不支持 --output") });
    expect(environment).not.toHaveBeenCalled();
  } finally { environment.mockRestore(); await ctx.disposeClients(); }
});

for (const scenario of ["success", "empty", "rows", "bytes", "query-failure", "ambiguous", "discovery-failure", "create-table", "tables", "databases"] as const) {
  test(`DB summary delivery: ${scenario}`, async () => {
    const first = provider();
    const calls: string[] = [];
    const values = Array.from({ length: 12 }, (_, id) => ({ id, content: "long-value:" + "x".repeat(300),
      nullable: null, enabled: false, marked: "hello|world\n\u001b[31m", a: 1, b: 2, c: 3, hidden: "outside-preview" }));
    const queryResult = result(scenario === "empty" ? [] : scenario === "create-table" ? [{ Table: "messages", "Create Table": "CREATE TABLE messages (id int)" }] : values,
      scenario === "rows" || scenario === "bytes" ? scenario : undefined);
    first.query = async sql => {
      calls.push(sql);
      if (calls.length === 1) {
        if (scenario === "discovery-failure") throw Object.assign(new Error("never-output"), { code: "ER_ACCESS_DENIED_ERROR" });
        return result([{ database_name: "app", table_name: "messages" }]);
      }
      if (scenario === "query-failure") throw Object.assign(new Error("never-output"), { code: "ER_TABLEACCESS_DENIED_ERROR" });
      return queryResult;
    };
    const resolve = spyOn(providers, "resolveDbProviders").mockResolvedValue({ service: "api",
      providers: scenario === "ambiguous" ? [first, provider("other")] : [first], failures: [] });
    const ctx = context();
    const environment = spyOn(ctx, "ensureEnvironment").mockResolvedValue();
    const output = spyOn(process.stdout, "write").mockImplementation(() => true);
    const evidenceOutput = spyOn(process.stderr, "write").mockImplementation(() => true);
    const render = spyOn(dbCommand, "render");
    const failed = ["query-failure", "ambiguous", "discovery-failure"].includes(scenario);
    const partial = scenario === "rows" || scenario === "bytes";
    const input: DbInput = { service: "api", database: "app", interactive: false,
      ...(scenario === "create-table" ? { table: "messages", showCreateTable: true }
        : scenario === "tables" ? { showTables: true } : scenario === "databases" ? { showDatabases: true }
          : { execute: "SELECT id, content FROM messages" }),
    };
    try {
      // Result delivery must remain visible even when the distribution suppresses progress logs.
      const outcome = await withLogger("error", () => dbCommand.run(ctx, input));
      expect(outcome.status).toBe(failed ? CommandStatus.Failed : partial ? CommandStatus.Partial : CommandStatus.Ok);
      directories.push(...outcome.artifacts.map(artifact => artifact.path));
      const countBeforeDelivery = calls.length;
      expect(await finalizeResult(ctx, dbCommand, outcome, { format: "summary" }, input)).toBe(failed ? 1 : 0);
      expect(calls.length).toBe(countBeforeDelivery);
      expect(render).not.toHaveBeenCalled();
      const stderr = evidenceOutput.mock.calls.map(([value]) => String(value)).join("");
      const directory = stderr.split("\n").find(line => line.startsWith("[delivery] Evidence: "))!.slice("[delivery] Evidence: ".length);
      directories.push(directory);
      const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
      const summary = readFileSync(join(directory, manifest.files.summary.path), "utf8");
      const stdout = output.mock.calls.map(([value]) => String(value)).join("");
      expect(stdout).toBe(summary);
      expect(stdout).not.toContain("never-output");
      expect(stdout).not.toContain(input.execute ?? "SELECT private");
      expect(stdout).toContain("Service：api");
      expect(stdout).toContain("完整已采集结果见证据目录");
      expect(manifest.execution.status).toBe(outcome.status);
      expect(existsSync(join(directory, "report.html"))).toBe(false);
      if (scenario === "query-failure") {
        expect(stdout).toContain("已尝试执行，未取得结果");
        expect(stdout).toContain("未知（未取得结果）");
        expect(stdout).toContain("ER\\_TABLEACCESS\\_DENIED\\_ERROR");
      } else if (scenario === "ambiguous" || scenario === "discovery-failure") {
        expect(stdout).toContain("选中目标：未选定");
        expect(stdout).toContain("目标 SQL：未执行");
        expect(stdout).toContain(scenario === "ambiguous" ? "歧义" : "ER\\_ACCESS\\_DENIED\\_ERROR");
        expect(calls).toHaveLength(1);
      } else if (scenario === "tables" || scenario === "databases") {
        expect(stdout).toContain("目标 SQL：不适用（仅库表发现）");
        expect(stdout).toContain("发现行数：1");
        expect(stdout).toContain("app");
        expect(calls).toHaveLength(1);
      } else {
        expect(stdout).toContain("选中目标：primary:3306 / app");
        expect(stdout).toContain("目标 SQL：已执行并返回结果");
        expect(stdout).toContain(`返回行数：${queryResult.rows.length}`);
        expect(stdout).toContain(`查询结果截断：${partial ? "是" : "否"}`);
        expect(calls).toHaveLength(2);
        const collection = JSON.parse(readFileSync(join(directory, manifest.files.collection.path), "utf8"));
        const query = collection.steps.find((step: { id: string }) => step.id === "query");
        const stored = JSON.parse(readFileSync(join(directory, query.raw_file), "utf8"));
        expect(stored.rows).toEqual(queryResult.rows);
        if (scenario === "empty") expect(stdout).toContain("无返回行");
        else if (scenario === "create-table") expect(stdout).toContain("CREATE TABLE messages");
        else {
          expect(stdout).toContain("预览 10/12 行、8/9 列");
          expect(stdout).not.toContain("outside-preview");
          expect(stdout).not.toContain("x".repeat(121));
          expect(stdout).not.toContain("\u001b");
          expect(stdout).toContain("hello\\|world");
          expect(stdout).toContain("null");
          expect(stdout).toContain("false");
          if (partial) expect(stdout).toContain(scenario === "rows" ? "行数限制" : "字节限制");
        }
      }
    } finally {
      render.mockRestore(); output.mockRestore(); evidenceOutput.mockRestore();
      resolve.mockRestore(); environment.mockRestore(); await ctx.disposeClients();
    }
  });
}

test("discovery summary stays bounded and surfaces failures even beyond the preview", () => {
  const discovery = [{ provider: provider(), result: result(Array.from({ length: 1000 }, (_, id) => ({ Database: `db${id}` }))) }];
  const summary = databaseSummary({ service: "api", action: "databases", status: CommandStatus.Partial,
    queryAttempted: false, discovery, failures: [{ id: "broken", reason: "unavailable" }] });
  expect(summary).toContain("仅预览前 10 条");
  expect(summary).not.toContain("db999");
  expect(summary).toContain("broken: unavailable");
  expect(summary).toContain("发现行数：1000");
  expect(summary.length).toBeLessThan(4000);
});
