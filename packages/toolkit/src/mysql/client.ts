import { ConcurrencyPool } from "../concurrency";
import { createConnection, type Connection, type ConnectionOptions, type RowDataPacket } from "mysql2/promise";
import type { Database, DatabaseTarget, DatabaseRow } from "./types";
import type { DataSource, ClientLifecycle } from "../datasource";
import { isConnectionNetworkError, type Transport, type PodPythonTransport } from "../transport";
import { queryMysqlViaPod } from "./pod";

export interface MysqlDatabaseOptions extends ClientLifecycle { connectTimeoutMs: number; queryTimeoutMs: number }
type ConnectionFactory = (options: ConnectionOptions) => Promise<Connection>;
type Session = { kind: "tcp"; connection: Connection } | { kind: "python"; transport: PodPythonTransport };

/** SQL is executed once; only native connection establishment may advance to another transport. */
export class MysqlDatabase implements Database {
  // A client owns one native session per target; serialize queries on both transports.
  readonly #queries = new ConcurrencyPool(1);
  readonly #connections = new Map<string, Promise<Session>>();
  constructor(
    private readonly transports: readonly Transport[],
    private readonly options: MysqlDatabaseOptions,
    private readonly connect: ConnectionFactory = createConnection,
  ) {}

  query(target: DatabaseTarget, sql: string, values: readonly unknown[]): Promise<DatabaseRow[]> {
    return this.#queries.run(() => this.#query(target, sql, values), this.options.signal);
  }

  async #query(target: DatabaseTarget, sql: string, values: readonly unknown[]): Promise<DatabaseRow[]> {
    this.options.signal?.throwIfAborted();
    const key = [target.host, target.port, target.database, target.user, target.password].join("\0");
    let pending = this.#connections.get(key);
    if (!pending) {
      pending = this.#open(target);
      this.#connections.set(key, pending);
    }
    let session: Session | undefined;
    try {
      session = await pending;
      this.options.signal?.throwIfAborted();
      if (session.kind === "python") return await queryMysqlViaPod(session.transport, target, sql, values, this.options);
      const [rows] = await session.connection.execute<RowDataPacket[]>({ sql, values: [...values], timeout: this.options.queryTimeoutMs });
      return rows as DatabaseRow[];
    } catch (error) {
      if (this.#connections.get(key) === pending) this.#connections.delete(key);
      if (session?.kind === "tcp") session.connection.destroy();
      throw error;
    }
  }

  async #open(target: DatabaseTarget): Promise<Session> {
    let reason: string | undefined;
    for (let i = 0; i < this.transports.length; i++) {
      const transport = this.transports[i]!;
      this.options.signal?.throwIfAborted();
      if (transport.kind === "python") {
        this.options.onRoute?.({ transport: transport.name, reason });
        return { kind: "python", transport };
      }
      try {
        const endpoint = await transport.connect(target);
        const connection = await this.connect({
          host: endpoint.host, port: endpoint.port, user: target.user, password: target.password, database: target.database,
          connectTimeout: this.options.connectTimeoutMs, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true,
        });
        this.options.onRoute?.({ transport: endpoint.host === target.host && endpoint.port === target.port ? "direct" : transport.name, reason });
        return { kind: "tcp", connection };
      } catch (error) {
        if (!isConnectionNetworkError(error) || i === this.transports.length - 1) throw error;
        reason = String((error as NodeJS.ErrnoException).code);
      }
    }
    throw new Error("MySQL DataSource has no transport");
  }

  async queryOne(target: DatabaseTarget, sql: string, values: readonly unknown[]): Promise<DatabaseRow | undefined> {
    return (await this.query(target, sql, values))[0];
  }
  close(): Promise<void> {
    return this.#queries.run(async () => {
      const pending = [...this.#connections.values()];
      this.#connections.clear();
      for (const result of await Promise.allSettled(pending)) {
        if (result.status === "fulfilled" && result.value.kind === "tcp") result.value.connection.destroy();
      }
    });
  }
}

export async function openMysql<Target extends DatabaseTarget>(source: DataSource<Target>, options: MysqlDatabaseOptions): Promise<{ database: Database; target: Target }> {
  const target = await source.resolve();
  const database = new MysqlDatabase(source.transports, options);
  options.onDispose?.(() => database.close());
  return { database, target };
}
