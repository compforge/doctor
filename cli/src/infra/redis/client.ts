import { createClient, type RedisClientType } from "@redis/client";

export interface RedisEndpoint {
  host: string;
  port: number;
}

export interface RedisMappedEndpoint extends RedisEndpoint {
  servername?: string;
}

export interface RedisCredentials {
  username?: string;
  password?: string;
}

export interface RedisConnectionConfig extends RedisCredentials {
  database: number;
  useSsl: boolean;
  timeoutMs: number;
}

export type RedisEndpointMapper = (endpoint: RedisEndpoint) => Promise<RedisMappedEndpoint>;

type NodeRedisClient = RedisClientType;
type NodeRedisClientFactory = (options: Parameters<typeof createClient>[0]) => NodeRedisClient;

export interface RedisManagedConnection extends RedisConnectionApi {
  readonly isReady: boolean;
  close(): void;
}

export type RedisConnectionFactory = (
  endpoint: RedisEndpoint,
  mapped: RedisMappedEndpoint,
  config: RedisConnectionConfig,
) => Promise<RedisManagedConnection>;

function stringValue(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return String(value ?? "");
}

function scalar(value: string): string | number {
  if (/^-?(?:\d+|\d+\.\d+)$/.test(value)) return Number(value);
  return value;
}

/** Redis INFO wire 文本解析；协议适配留在 infra，领域层只接收结构化字段。 */
export function parseRedisInfo(raw: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    const name = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (/^db\d+$/.test(name)) {
      result[name] = Object.fromEntries(value.split(",").map((item) => {
        const index = item.indexOf("=");
        return [item.slice(0, index), scalar(item.slice(index + 1))];
      }));
    } else {
      result[name] = scalar(value);
    }
  }
  return result;
}

export interface RedisConnectionApi {
  readonly endpoint: RedisEndpoint;
  ping(): Promise<string>;
  info(section?: string): Promise<Record<string, unknown>>;
  dbSize(): Promise<number>;
  command(args: string[]): Promise<unknown>;
  pipeline(commands: string[][]): Promise<unknown[]>;
  scan(cursor: string, count: number): Promise<{ cursor: string; keys: string[] }>;
}

export interface RedisAccessApi {
  connection(
    endpoint: RedisEndpoint,
    database: number,
    credentials?: RedisCredentials,
  ): Promise<RedisConnectionApi>;
  close(): Promise<void>;
}

export class RedisConnection implements RedisManagedConnection {
  private constructor(
    readonly endpoint: RedisEndpoint,
    private readonly client: NodeRedisClient,
    private readonly timeoutMs: number,
    private readonly lastError: () => Error | undefined,
  ) {}

  static async connect(
    endpoint: RedisEndpoint,
    mapped: RedisMappedEndpoint,
    config: RedisConnectionConfig,
    clientFactory: NodeRedisClientFactory = createClient as NodeRedisClientFactory,
  ): Promise<RedisConnection> {
    const baseSocket = {
      host: mapped.host,
      port: mapped.port,
      connectTimeout: config.timeoutMs,
      // doctor 是一次性只读任务：允许短暂网络抖动恢复，但不能无限阻塞退出。
      reconnectStrategy: (retries: number) => retries >= 2 ? false : 100 * 2 ** retries,
    };
    const socket = config.useSsl
      ? {
          ...baseSocket,
          tls: true as const,
          servername: mapped.servername ?? endpoint.host,
        }
      : {
          ...baseSocket,
          tls: false as const,
        };
    const client = clientFactory({
      socket,
      database: config.database,
      username: config.username,
      password: config.password,
      commandOptions: { timeout: config.timeoutMs },
    });
    let lastError: Error | undefined;
    // node-redis 要求 error listener 存在；保留最近错误，避免后续只剩模糊的 client closed。
    client.on("error", (err) => {
      lastError = err instanceof Error ? err : new Error(String(err));
    });
    await client.connect();
    return new RedisConnection(endpoint, client as NodeRedisClient, config.timeoutMs, () => lastError);
  }

  get isReady(): boolean {
    return this.client.isReady;
  }

  async #execute<T>(operationName: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await this.#executeOnce(operationName, operation);
    } catch (err) {
      // node-redis 正在自动重连时，只读命令允许再入队一次；全程仍受同一命令 deadline 约束。
      if (this.client.isOpen && !this.client.isReady) return this.#executeOnce(operationName, operation);
      throw err;
    }
  }

  async #executeOnce<T>(operationName: string, operation: () => Promise<T>): Promise<T> {
    if (!this.client.isOpen) {
      const reason = this.lastError()?.message;
      throw new Error(`Redis connection is closed${reason ? `: ${reason}` : ""}`);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Redis ${operationName} timed out after ${this.timeoutMs}ms (${this.endpoint.host}:${this.endpoint.port})`));
        // node-redis 的 command timeout 只覆盖待发送队列；销毁 socket 才能终止已发出但无响应的命令。
        this.close();
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([Promise.resolve().then(operation), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  ping(): Promise<string> {
    return this.#execute("PING", () => this.client.ping());
  }

  async info(section?: string): Promise<Record<string, unknown>> {
    const raw = await this.#execute(section ? `INFO ${section}` : "INFO", () => section
      ? this.client.sendCommand(["INFO", section])
      : this.client.sendCommand(["INFO"]));
    return parseRedisInfo(stringValue(raw));
  }

  async dbSize(): Promise<number> {
    return Number(await this.#execute("DBSIZE", () => this.client.sendCommand(["DBSIZE"])));
  }

  command(args: string[]): Promise<unknown> {
    return this.#execute(args[0]?.toUpperCase() ?? "command", () => this.client.sendCommand(args));
  }

  async pipeline(commands: string[][]): Promise<unknown[]> {
    const commandNames = new Set(commands.map((command) => command[0]?.toUpperCase()).filter(Boolean));
    const operationName = commandNames.size === 1 ? `${[...commandNames][0]} pipeline` : "pipeline";
    return await this.#execute(operationName, () => {
      // 重连后的只读重试必须重新创建 pipeline；已执行过的 multi builder 不可复用。
      const pipeline = this.client.multi();
      for (const command of commands) pipeline.addCommand(command);
      return pipeline.execAsPipeline();
    }) as unknown[];
  }

  async scan(cursor: string, count: number): Promise<{ cursor: string; keys: string[] }> {
    const reply = await this.command(["SCAN", cursor, "COUNT", String(count)]);
    if (!Array.isArray(reply) || !Array.isArray(reply[1])) throw new Error("Redis SCAN 返回格式无效");
    return { cursor: stringValue(reply[0]), keys: reply[1].map(stringValue) };
  }

  close(): void {
    if (this.client.isOpen) this.client.destroy();
  }
}

export class RedisAccess implements RedisAccessApi {
  readonly #connections = new Map<string, Promise<RedisManagedConnection>>();

  constructor(
    private readonly mapper: RedisEndpointMapper,
    private readonly baseConfig: Omit<RedisConnectionConfig, "database">,
    private readonly connectionFactory: RedisConnectionFactory = RedisConnection.connect,
  ) {}

  async connection(
    endpoint: RedisEndpoint,
    database: number,
    credentials: RedisCredentials = this.baseConfig,
  ): Promise<RedisManagedConnection> {
    const key = [
      endpoint.host,
      endpoint.port,
      database,
      credentials.username ?? "",
      credentials.password ?? "",
    ].join("\0");
    let pending = this.#connections.get(key);
    if (pending) {
      const connection = await pending;
      if (connection.isReady) return connection;
      if (this.#connections.get(key) === pending) {
        this.#connections.delete(key);
        connection.close();
      } else {
        return this.connection(endpoint, database, credentials);
      }
    }
    pending = this.mapper(endpoint).then((mapped) => this.connectionFactory(endpoint, mapped, {
        ...this.baseConfig,
        ...credentials,
        database,
      }));
    this.#connections.set(key, pending);
    void pending.catch(() => {
      // 建连失败不能污染缓存；下一次访问应获得一次全新的连接机会。
      if (this.#connections.get(key) === pending) this.#connections.delete(key);
    });
    return await pending;
  }

  async close(): Promise<void> {
    const pending = [...this.#connections.values()];
    this.#connections.clear();
    const settled = await Promise.allSettled(pending);
    for (const result of settled) if (result.status === "fulfilled") result.value.close();
  }
}
