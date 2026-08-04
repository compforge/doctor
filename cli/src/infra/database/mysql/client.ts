import { createConnection, type Connection, type RowDataPacket } from "mysql2/promise";
import type { Database, DatabaseRow, DatabaseTarget } from "..";

export interface MysqlEndpoint {
  host: string;
  port: number;
}

export type MysqlEndpointMapper = (endpoint: MysqlEndpoint) => Promise<MysqlEndpoint>;

export interface MysqlDatabaseOptions {
  connectTimeoutMs: number;
  queryTimeoutMs: number;
}

/** mysql2 implementation; callers own SQL and interpret returned rows. */
export class MysqlDatabase implements Database {
  readonly #connections = new Map<string, Promise<Connection>>();

  constructor(
    private readonly mapper: MysqlEndpointMapper,
    private readonly options: MysqlDatabaseOptions,
  ) {}

  async query(
    target: DatabaseTarget,
    sql: string,
    values: readonly unknown[],
  ): Promise<DatabaseRow[]> {
    const connection = await this.#connection(target);
    const [rows] = await connection.execute<RowDataPacket[]>({
      sql,
      values: [...values],
      timeout: this.options.queryTimeoutMs,
    });
    return rows as DatabaseRow[];
  }

  async queryOne(
    target: DatabaseTarget,
    sql: string,
    values: readonly unknown[],
  ): Promise<DatabaseRow | undefined> {
    return (await this.query(target, sql, values))[0];
  }

  async close(): Promise<void> {
    const settled = await Promise.allSettled(this.#connections.values());
    await Promise.allSettled(
      settled.flatMap((result) => result.status === "fulfilled" ? [result.value.end()] : []),
    );
    this.#connections.clear();
  }

  #connection(target: DatabaseTarget): Promise<Connection> {
    const key = [
      target.host,
      target.port,
      target.database,
      target.user,
      target.password,
    ].join("\0");
    let pending = this.#connections.get(key);
    if (!pending) {
      pending = this.mapper({ host: target.host, port: target.port }).then((endpoint) =>
        createConnection({
          host: endpoint.host,
          port: endpoint.port,
          user: target.user,
          password: target.password,
          database: target.database,
          connectTimeout: this.options.connectTimeoutMs,
          dateStrings: true,
          supportBigNumbers: true,
          bigNumberStrings: true,
        })
      );
      this.#connections.set(key, pending);
    }
    return pending;
  }
}
