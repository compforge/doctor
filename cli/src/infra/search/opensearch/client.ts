import { Client } from "@opensearch-project/opensearch";
import type { SearchEngine, SearchQuery, SearchResult } from "..";

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
