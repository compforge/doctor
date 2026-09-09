import type { Client as ManagedClient } from "../client";
import type { ConnectionSource, ClientLifecycle } from "../datasource";
import { Client } from "@opensearch-project/opensearch";
import type { SearchEngine, SearchQuery, SearchResult } from "./types";

export interface OpenSearchAuth {
  username?: string;
  password?: string;
}

export interface OpenSearchOptions {
  node: string;
  auth: OpenSearchAuth;
  requestTimeoutMs?: number;
}

export interface OpenSearchClientApi {
  count(params: Record<string, unknown>): Promise<{ body: { count: number } }>;
  search(params: Record<string, unknown>): Promise<{ body: SearchResult }>;
  ping(params?: Record<string, unknown>): Promise<unknown>;
  transport?: {
    request(params: {
      method: string;
      path: string;
      querystring?: Record<string, unknown>;
    }): Promise<{ body: unknown }>;
  };
  close(): Promise<void>;
}

/** OpenSearch-specific read APIs stay outside the engine-neutral SearchEngine contract. */
export interface OpenSearchReadApi extends SearchEngine {
  request(path: string, query?: SearchQuery): Promise<unknown>;
}

export function isOpenSearchReadApi(search: SearchEngine): search is OpenSearchReadApi {
  return typeof (search as Partial<OpenSearchReadApi>).request === "function";
}

function createClient(options: OpenSearchOptions): OpenSearchClientApi {
  return new Client({
    node: options.node,
    auth: options.auth.username && options.auth.password
      ? { username: options.auth.username, password: options.auth.password }
      : undefined,
    ssl: { rejectUnauthorized: false },
    requestTimeout: options.requestTimeoutMs ?? 60_000,
    maxRetries: 0,
  }) as unknown as OpenSearchClientApi;
}

/** Official OpenSearch client behind the engine-neutral SearchEngine contract. */
export class OpenSearchEngine implements OpenSearchReadApi {
  private readonly client: OpenSearchClientApi;

  constructor(options: OpenSearchOptions, client?: OpenSearchClientApi) {
    this.client = client ?? createClient(options);
  }

  async count(index: string, query: SearchQuery): Promise<number> {
    const response = await this.client.count({ index, body: { query } });
    return Number(response.body.count ?? 0);
  }

  async search(index: string, body: SearchQuery): Promise<SearchResult> {
    const response = await this.client.search({ index, body });
    return response.body;
  }

  async request(path: string, query?: SearchQuery): Promise<unknown> {
    if (!this.client.transport) throw new Error("OpenSearch client 不支持通用只读请求");
    const response = await this.client.transport.request({
      method: "GET",
      path,
      querystring: query,
    });
    return response.body;
  }

  ping(): Promise<unknown> {
    return this.client.ping();
  }

  close(): Promise<void> {
    return this.client.close();
  }
}

export class OpenSearchClient implements ManagedClient, OpenSearchReadApi {
  readonly #controller = new AbortController();
  readonly signal: AbortSignal;
  #initialization?: Promise<void>;
  #disposal?: Promise<void>;
  #engine?: OpenSearchEngine;
  readonly #operations = new Set<Promise<unknown>>();

  constructor(private readonly source: ConnectionSource<OpenSearchOptions>, lifecycle: ClientLifecycle = {}) {
    this.signal = lifecycle.signal ? AbortSignal.any([lifecycle.signal, this.#controller.signal]) : this.#controller.signal;
  }
  initialize(): Promise<void> {
    this.signal.throwIfAborted();
    return this.#initialization ??= (async () => {
      const target = await this.source.resolve();
      this.signal.throwIfAborted();
      const transport = this.source.transports[0];
      if (!transport || transport.kind !== "tcp") throw new Error("OpenSearch requires a TCP transport");
      const url = new URL(target.node);
      const endpoint = await transport.connect({ host: url.hostname, port: Number(url.port || (url.protocol === "https:" ? 443 : 80)) });
      this.signal.throwIfAborted();
      url.hostname = endpoint.host;
      url.port = String(endpoint.port);
      this.#engine = new OpenSearchEngine({ ...target, node: url.toString() });
    })();
  }
  #ready(): OpenSearchEngine {
    this.signal.throwIfAborted();
    if (!this.#engine) throw new Error("OpenSearch client is not initialized");
    return this.#engine;
  }
  #run<T>(operation: (engine: OpenSearchEngine) => Promise<T>): Promise<T> {
    const engine = this.#ready();
    const pending = operation(engine);
    this.#operations.add(pending);
    void pending.then(() => this.#operations.delete(pending), () => this.#operations.delete(pending));
    return pending;
  }
  count(index: string, query: SearchQuery) { return this.#run(engine => engine.count(index, query)); }
  search(index: string, body: SearchQuery) { return this.#run(engine => engine.search(index, body)); }
  request(path: string, query?: SearchQuery) { return this.#run(engine => engine.request(path, query)); }
  ping() { return this.#run(engine => engine.ping()); }
  close(): Promise<void> { return this.dispose(); }
  dispose(): Promise<void> {
    return this.#disposal ??= (async () => {
      this.#controller.abort(new Error("OpenSearch client disposed"));
      await this.#initialization?.catch(() => {});
      await Promise.allSettled(this.#operations);
      await this.#engine?.close();
    })();
  }
}

export async function openOpenSearch(source: ConnectionSource<OpenSearchOptions>, lifecycle: ClientLifecycle = {}): Promise<OpenSearchClient> {
  const client = new OpenSearchClient(source, lifecycle);
  try { await client.initialize(); }
  catch (error) { await client.dispose(); throw error; }
  lifecycle.onDispose?.(() => client.dispose());
  return client;
}
