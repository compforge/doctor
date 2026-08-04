import { describe, expect, test } from "bun:test";
import {
  normalizeOpenSearchHost,
  OpenSearchEngine,
  parseOpenSearchEndpoint,
  probeOpenSearchUrl,
  resolveOpenSearchAuth,
  type OpenSearchClientApi,
} from "../src/infra/search/opensearch";

describe("OpenSearch config", () => {
  test("flags 优先于环境变量，半套凭据不采用", () => {
    expect(resolveOpenSearchAuth("u", "p", {
      DOCTOR_OPENSEARCH_USERNAME: "env-u",
      DOCTOR_OPENSEARCH_PASSWORD: "env-p",
    })).toEqual({ username: "u", password: "p" });
    expect(resolveOpenSearchAuth(undefined, undefined, {
      DOCTOR_OPENSEARCH_USERNAME: "env-u",
      DOCTOR_OPENSEARCH_PASSWORD: "env-p",
    })).toEqual({ username: "env-u", password: "env-p" });
    expect(resolveOpenSearchAuth("u", undefined, {
      DOCTOR_OPENSEARCH_PASSWORD: "env-p",
    })).toEqual({});
  });

  test("地址标准化保留显式 scheme，并为裸 host 补 9200", () => {
    expect(normalizeOpenSearchHost("https://os.example:9200/")).toEqual({
      url: "https://os.example:9200",
    });
    expect(normalizeOpenSearchHost("10.0.0.1:9201")).toEqual({ hostPort: "10.0.0.1:9201" });
    expect(normalizeOpenSearchHost("opensearch.ns")).toEqual({ hostPort: "opensearch.ns:9200" });
  });

  test("endpoint parser 分离 userinfo 并保留裸地址的 scheme 探测语义", () => {
    expect(parseOpenSearchEndpoint("https://u:p@os.example:9443/")).toMatchObject({
      safeEndpoint: "https://os.example:9443",
      username: "u",
      password: "p",
      schemeExplicit: true,
    });
    expect(parseOpenSearchEndpoint("os.ns:9201")).toMatchObject({
      safeEndpoint: "os.ns:9201",
      host: "os.ns",
      port: 9201,
      schemeExplicit: false,
    });
  });

  test("scheme 探测把鉴权错误视为 endpoint 已可达", async () => {
    const visited: string[] = [];
    const closed: string[] = [];
    const node = await probeOpenSearchUrl("os:9200", {}, (url) => ({
      ping: async () => {
        visited.push(url);
        if (url.startsWith("http://")) throw { meta: { statusCode: 503 } };
        throw { meta: { statusCode: 401 } };
      },
      close: async () => { closed.push(url); },
    }));
    expect(node).toBe("https://os:9200");
    expect(visited).toEqual(["http://os:9200", "https://os:9200"]);
    expect(closed).toEqual(visited);
  });
});

test("OpenSearchEngine 将通用 count/search/request 映射到官方 client", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let closed = false;
  const client: OpenSearchClientApi = {
    count: async (params) => {
      calls.push({ method: "count", params });
      return { body: { count: 3 } };
    },
    search: async (params) => {
      calls.push({ method: "search", params });
      return { body: { hits: { hits: [] } } };
    },
    transport: {
      request: async (params) => {
        calls.push({ method: "request", params });
        return { body: { status: "green" } };
      },
    },
    ping: async () => true,
    close: async () => { closed = true; },
  };
  const engine = new OpenSearchEngine({ node: "http://os:9200", auth: {} }, client);
  expect(await engine.count("idx", { term: { traceID: "t1" } })).toBe(3);
  expect(await engine.search("idx", { size: 1 })).toEqual({ hits: { hits: [] } });
  expect(await engine.request("/_cluster/health", { level: "cluster" })).toEqual({ status: "green" });
  expect(calls).toEqual([
    {
      method: "count",
      params: { index: "idx", body: { query: { term: { traceID: "t1" } } } },
    },
    { method: "search", params: { index: "idx", body: { size: 1 } } },
    {
      method: "request",
      params: {
        method: "GET",
        path: "/_cluster/health",
        querystring: { level: "cluster" },
      },
    },
  ]);
  await engine.close();
  expect(closed).toBe(true);
});
