import { Parser } from "node-sql-parser/build/mysql";
import { CommandInputError } from "../../command";

const parser = new Parser();
const functions = new Set("COUNT SUM AVG MIN MAX COALESCE IFNULL NULLIF IF ABS ROUND CEIL CEILING FLOOR LENGTH CHAR_LENGTH LOWER UPPER CONCAT CONCAT_WS SUBSTRING SUBSTR LEFT RIGHT TRIM REPLACE DATE DATE_FORMAT DATEDIFF TIMESTAMPDIFF NOW CURRENT_TIMESTAMP UNIX_TIMESTAMP FROM_UNIXTIME JSON_EXTRACT JSON_UNQUOTE JSON_LENGTH JSON_TYPE CAST CONVERT ROW_NUMBER RANK DENSE_RANK".split(" "));

/** Align lexical interpretation with toolbox's NO_BACKSLASH_ESCAPES session; fail closed on executable comments. */
function checkLexicalBoundary(sql: string): void {
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (ch === "\\") throw new CommandInputError("SQL 中的反斜杠值请通过 --params 绑定；字符串内引号使用成对引号");
    if (ch === "'" || ch === '"' || ch === "`") {
      for (i++; i < sql.length; i++) {
        if (sql[i] === "\\") throw new CommandInputError("SQL 字符串中的反斜杠值请通过 --params 绑定");
        if (sql[i] === ch) { if (sql[i + 1] === ch) i++; else break; }
      }
    } else if (sql.startsWith("/*", i)) {
      if (/^\/\*(?:[!+]|M!)/i.test(sql.slice(i))) throw new CommandInputError("不支持可执行 SQL 注释或 optimizer hint");
      const end = sql.indexOf("*/", i + 2);
      if (end < 0 || sql.slice(i + 2, end).includes("/*")) throw new CommandInputError("SQL 注释未闭合或嵌套");
      i = end + 1;
    } else if (sql.startsWith("--", i)) {
      if (sql[i + 2] && !/\s/.test(sql[i + 2]!)) throw new CommandInputError("MySQL -- 注释后必须有空白");
      const end = sql.indexOf("\n", i); i = end < 0 ? sql.length : end;
    } else if (ch === "#" || ch === "@") throw new CommandInputError("不支持 # 注释或会话变量；请使用标准注释和 --params");
  }
}

/** Parser classification + conservative function policy supplement (not replace) engine READ ONLY. */
export function validateSql(sql: string, parameterCount: number): void {
  if (!sql.trim() || Buffer.byteLength(sql) > 1024 * 1024) throw new CommandInputError("SQL 必须非空且不超过 1 MiB");
  checkLexicalBoundary(sql);
  let parsed: unknown;
  try { parsed = parser.astify(sql, { database: "MySQL" }); }
  catch { throw new CommandInputError("无法解析为受支持的 MySQL 只读 SQL（错误详情不回显 SQL）"); }
  const statements = Array.isArray(parsed) ? parsed : [parsed];
  if (statements.length !== 1) throw new CommandInputError("只接受一条 SQL，不支持批量脚本");
  const root = statements[0] as Record<string, unknown>;
  const query = root.type === "explain" ? root.expr as Record<string, unknown> : root;
  if (query?.type !== "select") throw new CommandInputError("SQL 仅支持 SELECT / WITH SELECT / EXPLAIN SELECT；库表信息请使用 --show-* 参数");
  let placeholders = 0;
  function visit(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    if (node.type === "select" && (node.locking_read || (node.into as { position?: unknown } | undefined)?.position)) {
      throw new CommandInputError("不允许锁定查询或 SELECT INTO");
    }
    if (["insert", "update", "delete", "call", "set", "var", "param", "assign"].includes(String(node.type))) throw new CommandInputError("不支持有副作用的 SQL 或命名参数");
    if (node.type === "function" || node.type === "aggr_func") {
      const name = node.name as string | { name?: { type: string; value: string }[]; schema?: unknown };
      const identifier = typeof name === "string" ? name : !name.schema && name.name?.length === 1 && name.name[0]?.type === "default" ? name.name[0].value : "";
      if (!functions.has(identifier.toUpperCase())) throw new CommandInputError("SQL 包含未获准的函数；不允许存储函数、UDF、文件读取、锁或 sleep");
    }
    if (node.type === "origin" && node.value === "?") placeholders++;
    Object.values(node).forEach(visit);
  }
  visit(root);
  if (placeholders !== parameterCount) throw new CommandInputError(`SQL 有 ${placeholders} 个 ? 占位符，--params 提供 ${parameterCount} 个值`);
}

export function quoteIdentifier(value: string): string {
  if (!value || value.includes("\0")) throw new CommandInputError("数据库和表名不能为空或包含 NUL");
  return `\`${value.replaceAll("`", "``")}\``;
}
