import type { DatabaseRow, DatabaseTarget } from "./types";
import type { PodPythonTransport } from "../transport";

// Preserve prepared-statement placeholders inside literals, identifiers and comments.
// PyMySQL binds values using %s; escape literal percent signs before adapting placeholders.
export function preparePodSql(sql: string, values: readonly unknown[]): string {
  let index = 0;
  const rendered = sql.replace(/%/g, "%%").replace(
    /'(?:\\.|''|[^'\\])*'|"(?:\\.|""|[^"\\])*"|`(?:``|[^`])*`|--\s[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|\?/g,
    (token) => {
      if (token !== "?") return token;
      if (index >= values.length) throw new Error("SQL placeholder count exceeds bound values");
      index++;
      return "%s";
    },
  );
  if (index !== values.length) throw new Error("SQL bound values exceed placeholder count");
  return rendered;
}

// Credentials travel only on stdin; argv contains protocol code without request data.
// A process deadline also closes the connection if the kubectl client disconnects mid-query.
const POD_QUERY = String.raw`
import json, math, signal, sys


def timeout(signum, frame):
    raise TimeoutError()


def encode(value):
    if isinstance(value, bytes):
        return {"type": "Buffer", "data": list(value)}
    raise TypeError(type(value).__name__)


try:
    request = json.load(sys.stdin)
    signal.signal(signal.SIGALRM, timeout)
    signal.alarm(math.ceil(request["queryTimeoutMs"] / 1000))
    import pymysql
    from pymysql.constants import FIELD_TYPE
    target = request["target"]
    converters = pymysql.converters.conversions.copy()
    # Match mysql2 dateStrings/supportBigNumbers/bigNumberStrings and native JSON decoding.
    for field in (FIELD_TYPE.DATE, FIELD_TYPE.DATETIME, FIELD_TYPE.TIMESTAMP, FIELD_TYPE.TIME,
                  FIELD_TYPE.LONGLONG, FIELD_TYPE.DECIMAL, FIELD_TYPE.NEWDECIMAL):
        converters[field] = str
    converters[FIELD_TYPE.JSON] = json.loads
    connection = pymysql.connect(
        host=target["host"], port=target["port"], database=target["database"], user=target["user"],
        password=target["password"], charset="utf8mb4",
        connect_timeout=math.ceil(request["connectTimeoutMs"] / 1000),
        read_timeout=math.ceil(request["queryTimeoutMs"] / 1000),
        write_timeout=math.ceil(request["queryTimeoutMs"] / 1000),
        conv=converters,
    )
    try:
        with connection.cursor(pymysql.cursors.DictCursor) as cursor:
            cursor.execute(request["sql"], request["values"])
            rows = cursor.fetchall()
        print(json.dumps({"rows": rows}, default=encode, ensure_ascii=False))
    finally:
        connection.close()
except Exception as error:
    # DB errors may include SQL values; expose only the exception class and numeric server code.
    code = error.args[0] if error.args and isinstance(error.args[0], int) else None
    print(json.dumps({"error": type(error).__name__, "code": code}))
finally:
    signal.alarm(0)
`;


export async function queryMysqlViaPod(
  transport: PodPythonTransport, target: DatabaseTarget, sql: string, values: readonly unknown[],
  options: { connectTimeoutMs: number; queryTimeoutMs: number },
): Promise<DatabaseRow[]> {
  const raw = await transport.run(POD_QUERY, {
    target, sql: preparePodSql(sql, values), values, ...options,
  }, options.queryTimeoutMs + 3_000);
  const response = JSON.parse(raw, (_key, value) => (
    value?.type === "Buffer" && Array.isArray(value.data) ? Buffer.from(value.data) : value
  )) as { rows?: DatabaseRow[]; error?: string; code?: number };
  if (response.error || !Array.isArray(response.rows)) {
    throw new Error(`MySQL via Pod failed: ${response.error ?? "invalid response"}${response.code ? ` (${response.code})` : ""}`);
  }
  return response.rows;
}
