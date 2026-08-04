export interface DatabaseIdentity {
  user: string;
  password: string;
}

export interface DatabaseTarget extends DatabaseIdentity {
  host: string;
  port: number;
  database: string;
}

export type DatabaseRow = Record<string, unknown>;

/** Storage-neutral operations available to Doctor and Plugin implementations. */
export interface Database {
  query(
    target: DatabaseTarget,
    sql: string,
    values: readonly unknown[],
  ): Promise<DatabaseRow[]>;
  queryOne(
    target: DatabaseTarget,
    sql: string,
    values: readonly unknown[],
  ): Promise<DatabaseRow | undefined>;
  close(): Promise<void>;
}
