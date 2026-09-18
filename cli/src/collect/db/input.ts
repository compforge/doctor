import { createReadStream } from "node:fs";
import { addAbortSignal } from "node:stream";
import { currentCommandSignal } from "../../command/execution-scope";
import type { CommandInput } from "../../command";
import { CommandInputError } from "../../command";
import type { KubernetesCommandInput } from "../../command/kubernetes-target";
import { canPrompt, chooseParameter, inputParameter } from "../../terminal/parameters";
import { validateSql } from "./sql";

export interface DbInput extends CommandInput, KubernetesCommandInput {
  service?: string;
  database?: string;
  table?: string;
  pod?: string;
  container?: string;
  showDatabases?: boolean;
  showTables?: boolean;
  showCreateTable?: boolean;
  execute?: string;
  file?: string;
  params?: string;
  timeout?: string;
  maxRows?: string;
  maxBytes?: string;
}
export type DbAction = "databases" | "tables" | "create-table" | "query";
export interface DbRequest {
  input: DbInput;
  interactive: boolean;
  action: DbAction;
  database?: string;
  table?: string;
  sql?: string;
  values: unknown[];
  limits: { timeoutMs: number; maxRows: number; maxBytes: number };
}

function positive(value: string | undefined, fallback: number, name: string, max: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) throw new CommandInputError(`${name} 必须为 1..${max} 的整数`);
  return parsed;
}

export function tableScope(database?: string, table?: string): { database?: string; table?: string } {
  database = database?.trim() || undefined;
  if (!table) return { database };
  const parts = table.split(".");
  if (parts.length > 2 || parts.some(part => !part.trim())) throw new CommandInputError("--table 使用 table 或 database.table");
  if (parts.length === 1) return { database, table: parts[0]!.trim() };
  if (database && database !== parts[0]!.trim()) throw new CommandInputError("--database 与 --table 的 database 冲突");
  return { database: parts[0]!.trim(), table: parts[1]!.trim() };
}

export function validateDbInput(input: DbInput): void {
  const actions = [input.showDatabases, input.showTables, input.showCreateTable, input.execute !== undefined, input.file !== undefined];
  if (actions.filter(Boolean).length > 1) throw new CommandInputError("--show-databases / --show-tables / --show-create-table / --execute / --file 互斥");
  if (input.params !== undefined && input.execute === undefined && input.file === undefined) throw new CommandInputError("--params 必须与 --execute 或 --file 一起使用");
  tableScope(input.database, input.table);
  queryLimits(input);
  if (!actions.some(Boolean) && !canPrompt({ interactive: input.interactive })) {
    throw new CommandInputError("缺少数据库操作：请指定 --show-databases / --show-tables / --show-create-table / -e / --file");
  }
}

function queryLimits(input: DbInput) {
  return {
    timeoutMs: positive(input.timeout, 15, "--timeout", 300) * 1000,
    maxRows: positive(input.maxRows, 1000, "--max-rows", 100_000),
    maxBytes: positive(input.maxBytes, 4 * 1024 * 1024, "--max-bytes", 64 * 1024 * 1024),
  };
}

async function readSql(path: string): Promise<string> {
  const stream = path === "-" ? process.stdin : createReadStream(path);
  const signal = currentCommandSignal();
  if (signal) addAbortSignal(signal, stream);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.byteLength;
    if (bytes > 1024 * 1024) throw new CommandInputError("SQL 输入不能超过 1 MiB");
    chunks.push(data);
  }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw new CommandInputError("SQL 文件必须是 UTF-8"); }
}

export async function resolveDbRequest(input: DbInput): Promise<DbRequest> {
  validateDbInput(input);
  const interactive = canPrompt({ interactive: input.interactive, stdinOwned: input.file === "-" });
  let action: DbAction | undefined = input.showDatabases ? "databases" : input.showTables ? "tables"
    : input.showCreateTable ? "create-table" : input.execute !== undefined || input.file !== undefined ? "query" : undefined;
  let sql = input.execute;
  let file = input.file;
  if (!action) {
    const options = { "查看数据库": "databases", "查看表": "tables", "查看建表语句": "create-table", "执行只读 SQL": "query" } as const;
    const choice = await chooseParameter("操作（--show-databases / --show-tables / --show-create-table / -e / --file）", Object.keys(options), interactive);
    action = options[choice as keyof typeof options];
    if (action === "query") {
      const source = await chooseParameter("SQL 来源", ["输入 SQL", "读取 SQL 文件"], interactive);
      if (source === "输入 SQL") sql = await inputParameter("SQL（单条语句，复杂 SQL 请用文件）", interactive);
      else {
        file = await inputParameter("SQL 文件路径", interactive);
        if (file === "-") throw new CommandInputError("交互录入时请提供文件路径；stdin SQL 请显式使用 --file -");
      }
    }
  }
  if (file !== undefined) sql = await readSql(file);
  let values: unknown[] = [];
  if (input.params !== undefined) {
    let parsed: unknown;
    try { parsed = JSON.parse(input.params); } catch { throw new CommandInputError("--params 必须为 JSON 数组"); }
    if (!Array.isArray(parsed) || parsed.some(v => v !== null && !["string", "number", "boolean"].includes(typeof v))) {
      throw new CommandInputError("--params 仅支持由 string / number / boolean / null 组成的 JSON 数组");
    }
    values = parsed;
  }
  if (action === "query") validateSql(sql ?? "", values.length);
  return { input, interactive, action, ...tableScope(input.database, input.table), sql, values, limits: queryLimits(input) };
}
