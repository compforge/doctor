import type { Database, DatabaseRow, DatabaseTarget } from "../../infra/database";

export const MYSQL_LOAD_WINDOW_MS = 5_000;

export interface MysqlServerInfo {
  version: string;
  readOnly: boolean;
  maxConnections: number;
}

export interface MysqlCapacityFact {
  status: "collected";
  dataBytes: number;
  indexBytes: number;
  totalBytes: number;
  tableCount: number;
  scope: "schema-logical-size";
  approximate: true;
  topTables: Array<{
    table: string;
    engine: string;
    estimatedRows: number;
    dataBytes: number;
    indexBytes: number;
    totalBytes: number;
    dataFreeBytes: number;
  }>;
}

export interface MysqlStatusSnapshot {
  capturedAtMs: number;
  uptimeSeconds: number;
  queries: number;
  commits: number;
  rollbacks: number;
  slowQueries: number;
  temporaryDiskTables: number;
  abortedConnects: number;
  bytesReceived: number;
  bytesSent: number;
  rowsRead: number;
  rowsInserted: number;
  rowsUpdated: number;
  rowsDeleted: number;
  connectedThreads: number;
  runningThreads: number;
}

export interface MysqlLoadFact {
  status: "collected";
  windowSeconds: number;
  counterReset: boolean;
  current: {
    connectedThreads: number;
    runningThreads: number;
    maxConnections: number;
    connectionUsagePercent?: number;
  };
  rates: {
    queriesPerSecond?: number;
    transactionsPerSecond?: number;
    bytesReceivedPerSecond?: number;
    bytesSentPerSecond?: number;
    rowsReadPerSecond?: number;
    rowsWrittenPerSecond?: number;
  };
  delta: {
    slowQueries?: number;
    temporaryDiskTables?: number;
    abortedConnects?: number;
  };
}

export interface MysqlLockWaitFact {
  status: "collected";
  waitingTransactions: number;
  longestWaitSeconds: number;
  activeTransactions: number;
  longestTransactionSeconds: number;
}

export interface MysqlFinding {
  severity: "warning" | "critical";
  kind: string;
  [key: string]: unknown;
}

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function stringValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function statusValue(values: ReadonlyMap<string, string>, name: string): number {
  return numberValue(values.get(name));
}

export function parseMysqlStatusSnapshot(
  rows: readonly DatabaseRow[],
  capturedAtMs: number = Date.now(),
): MysqlStatusSnapshot {
  const values = new Map<string, string>();
  for (const row of rows) {
    const name = stringValue(row.Variable_name ?? row.variable_name);
    if (name) values.set(name, stringValue(row.Value ?? row.variable_value));
  }
  return {
    capturedAtMs,
    uptimeSeconds: statusValue(values, "Uptime"),
    queries: statusValue(values, "Queries"),
    commits: statusValue(values, "Com_commit"),
    rollbacks: statusValue(values, "Com_rollback"),
    slowQueries: statusValue(values, "Slow_queries"),
    temporaryDiskTables: statusValue(values, "Created_tmp_disk_tables"),
    abortedConnects: statusValue(values, "Aborted_connects"),
    bytesReceived: statusValue(values, "Bytes_received"),
    bytesSent: statusValue(values, "Bytes_sent"),
    rowsRead: statusValue(values, "Innodb_rows_read"),
    rowsInserted: statusValue(values, "Innodb_rows_inserted"),
    rowsUpdated: statusValue(values, "Innodb_rows_updated"),
    rowsDeleted: statusValue(values, "Innodb_rows_deleted"),
    connectedThreads: statusValue(values, "Threads_connected"),
    runningThreads: statusValue(values, "Threads_running"),
  };
}

function delta(before: number, after: number): number | undefined {
  return after >= before ? after - before : undefined;
}

function rate(value: number | undefined, seconds: number): number | undefined {
  return value === undefined ? undefined : value / seconds;
}

export function buildMysqlLoadFact(
  before: MysqlStatusSnapshot,
  after: MysqlStatusSnapshot,
  maxConnections: number,
): MysqlLoadFact {
  const windowSeconds = Math.max(0.001, (after.capturedAtMs - before.capturedAtMs) / 1_000);
  const cumulativePairs = [
    [before.queries, after.queries],
    [before.commits, after.commits],
    [before.rollbacks, after.rollbacks],
    [before.slowQueries, after.slowQueries],
    [before.temporaryDiskTables, after.temporaryDiskTables],
    [before.abortedConnects, after.abortedConnects],
    [before.bytesReceived, after.bytesReceived],
    [before.bytesSent, after.bytesSent],
    [before.rowsRead, after.rowsRead],
    [before.rowsInserted, after.rowsInserted],
    [before.rowsUpdated, after.rowsUpdated],
    [before.rowsDeleted, after.rowsDeleted],
  ] as const;
  const counterReset = after.uptimeSeconds < before.uptimeSeconds
    || cumulativePairs.some(([left, right]) => right < left);
  const change = (left: number, right: number) => counterReset ? undefined : delta(left, right);
  const rowsWritten = [
    change(before.rowsInserted, after.rowsInserted),
    change(before.rowsUpdated, after.rowsUpdated),
    change(before.rowsDeleted, after.rowsDeleted),
  ];
  const written = rowsWritten.every((value) => value !== undefined)
    ? rowsWritten.reduce<number>((sum, value) => sum + value!, 0)
    : undefined;
  const transactions = [
    change(before.commits, after.commits),
    change(before.rollbacks, after.rollbacks),
  ];
  const transactionCount = transactions.every((value) => value !== undefined)
    ? transactions.reduce<number>((sum, value) => sum + value!, 0)
    : undefined;
  return {
    status: "collected",
    windowSeconds,
    counterReset,
    current: {
      connectedThreads: after.connectedThreads,
      runningThreads: after.runningThreads,
      maxConnections,
      connectionUsagePercent: maxConnections > 0
        ? after.connectedThreads / maxConnections * 100
        : undefined,
    },
    rates: {
      queriesPerSecond: rate(change(before.queries, after.queries), windowSeconds),
      transactionsPerSecond: rate(transactionCount, windowSeconds),
      bytesReceivedPerSecond: rate(change(before.bytesReceived, after.bytesReceived), windowSeconds),
      bytesSentPerSecond: rate(change(before.bytesSent, after.bytesSent), windowSeconds),
      rowsReadPerSecond: rate(change(before.rowsRead, after.rowsRead), windowSeconds),
      rowsWrittenPerSecond: rate(written, windowSeconds),
    },
    delta: {
      slowQueries: change(before.slowQueries, after.slowQueries),
      temporaryDiskTables: change(before.temporaryDiskTables, after.temporaryDiskTables),
      abortedConnects: change(before.abortedConnects, after.abortedConnects),
    },
  };
}

export async function collectMysqlServerInfo(
  database: Database,
  target: DatabaseTarget,
): Promise<MysqlServerInfo> {
  const row = await database.queryOne(
    target,
    "SELECT VERSION() AS version, @@global.read_only AS read_only, @@global.max_connections AS max_connections",
    [],
  );
  return {
    version: stringValue(row?.version),
    readOnly: numberValue(row?.read_only) !== 0,
    maxConnections: numberValue(row?.max_connections),
  };
}

export async function collectMysqlCapacity(
  database: Database,
  target: DatabaseTarget,
): Promise<MysqlCapacityFact> {
  const row = await database.queryOne(
    target,
    "SELECT COALESCE(SUM(data_length), 0) AS data_bytes, COALESCE(SUM(index_length), 0) AS index_bytes, COUNT(*) AS table_count FROM information_schema.tables WHERE table_schema = ?",
    [target.database],
  );
  const topRows = await database.query(
    target,
    "SELECT table_name AS doctor_table_name, engine AS doctor_engine, COALESCE(table_rows, 0) AS estimated_rows, COALESCE(data_length, 0) AS data_bytes, COALESCE(index_length, 0) AS index_bytes, COALESCE(data_free, 0) AS data_free_bytes FROM information_schema.tables WHERE table_schema = ? ORDER BY COALESCE(data_length, 0) + COALESCE(index_length, 0) DESC LIMIT 10",
    [target.database],
  );
  const dataBytes = numberValue(row?.data_bytes);
  const indexBytes = numberValue(row?.index_bytes);
  return {
    status: "collected",
    dataBytes,
    indexBytes,
    totalBytes: dataBytes + indexBytes,
    tableCount: numberValue(row?.table_count),
    scope: "schema-logical-size",
    approximate: true,
    topTables: topRows.map((table) => {
      const tableDataBytes = numberValue(table.data_bytes);
      const tableIndexBytes = numberValue(table.index_bytes);
      return {
        table: stringValue(table.doctor_table_name),
        engine: stringValue(table.doctor_engine),
        estimatedRows: numberValue(table.estimated_rows),
        dataBytes: tableDataBytes,
        indexBytes: tableIndexBytes,
        totalBytes: tableDataBytes + tableIndexBytes,
        dataFreeBytes: numberValue(table.data_free_bytes),
      };
    }),
  };
}

async function collectMysqlStatus(
  database: Database,
  target: DatabaseTarget,
): Promise<MysqlStatusSnapshot> {
  return parseMysqlStatusSnapshot(
    await database.query(target, "SHOW GLOBAL STATUS", []),
    Date.now(),
  );
}

export async function collectMysqlLoad(
  database: Database,
  target: DatabaseTarget,
  maxConnections: number,
  windowMs: number = MYSQL_LOAD_WINDOW_MS,
  sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<MysqlLoadFact> {
  const before = await collectMysqlStatus(database, target);
  await sleep(windowMs);
  const after = await collectMysqlStatus(database, target);
  return buildMysqlLoadFact(before, after, maxConnections);
}

export async function collectMysqlLockWaits(
  database: Database,
  target: DatabaseTarget,
): Promise<MysqlLockWaitFact> {
  const row = await database.queryOne(
    target,
    "SELECT COUNT(*) AS active_transactions, COALESCE(SUM(CASE WHEN trx_state = 'LOCK WAIT' THEN 1 ELSE 0 END), 0) AS waiting_transactions, COALESCE(MAX(CASE WHEN trx_state = 'LOCK WAIT' THEN TIMESTAMPDIFF(SECOND, trx_wait_started, NOW()) ELSE 0 END), 0) AS longest_wait_seconds, COALESCE(MAX(TIMESTAMPDIFF(SECOND, trx_started, NOW())), 0) AS longest_transaction_seconds FROM information_schema.innodb_trx",
    [],
  );
  return {
    status: "collected",
    waitingTransactions: numberValue(row?.waiting_transactions),
    longestWaitSeconds: numberValue(row?.longest_wait_seconds),
    activeTransactions: numberValue(row?.active_transactions),
    longestTransactionSeconds: numberValue(row?.longest_transaction_seconds),
  };
}

export function detectMysqlFindings(input: {
  queryable: boolean;
  load?: MysqlLoadFact;
  locks?: MysqlLockWaitFact;
}): MysqlFinding[] {
  const findings: MysqlFinding[] = [];
  if (!input.queryable) findings.push({ severity: "critical", kind: "db.query-unhealthy" });
  const usage = input.load?.current.connectionUsagePercent;
  if (usage !== undefined && usage >= 95) {
    findings.push({ severity: "critical", kind: "db.connections-exhausted", usagePercent: usage });
  } else if (usage !== undefined && usage >= 80) {
    findings.push({ severity: "warning", kind: "db.connections-high", usagePercent: usage });
  }
  if ((input.load?.delta.abortedConnects ?? 0) > 0) {
    findings.push({
      severity: "warning",
      kind: "db.connections-rejected",
      count: input.load!.delta.abortedConnects,
      windowSeconds: input.load!.windowSeconds,
    });
  }
  if ((input.load?.delta.slowQueries ?? 0) > 0) {
    findings.push({
      severity: "warning",
      kind: "db.slow-queries-observed",
      count: input.load!.delta.slowQueries,
      windowSeconds: input.load!.windowSeconds,
    });
  }
  if ((input.locks?.waitingTransactions ?? 0) > 0) {
    findings.push({
      severity: input.locks!.longestWaitSeconds >= 10 ? "critical" : "warning",
      kind: "db.lock-waits-observed",
      waitingTransactions: input.locks!.waitingTransactions,
      longestWaitSeconds: input.locks!.longestWaitSeconds,
    });
  }
  return findings;
}
