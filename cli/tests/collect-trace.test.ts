import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OUTCOME_UNREACHED_REASON } from "../src/collect/evidence";
import type { SearchEngine } from "../src/infra/search";
import { pickOpenSearchService } from "../src/infra/search/opensearch";
import {
  buildIndexExpr,
  countSpans,
  downloadSpans,
  resolveTraceId,
} from "../src/collect/trace/opensearch";
import {
  accumulateStats,
  buildTraceSummary,
  collectTrace,
  defaultTraceBundleName,
  newTraceStats,
  parseTraceOutputFormat,
  resolveTraceHtmlPath,
} from "../src/collect/trace";

describe("buildIndexExpr", () => {
  test("默认通配", () => expect(buildIndexExpr()).toBe("jaeger-span-*"));
  test("--index-date 拼单日索引", () => expect(buildIndexExpr(undefined, "2026-07-09")).toBe("jaeger-span-2026-07-09"));
  test("--index 显式最优先", () => expect(buildIndexExpr("my-span-*", "2026-07-09")).toBe("my-span-*"));
});

function svcList(items: Array<{ ns: string; name: string; ports: number[]; headless?: boolean }>): string {
  return JSON.stringify({
    items: items.map((it) => ({
      metadata: { namespace: it.ns, name: it.name },
      spec: { ports: it.ports.map((p) => ({ port: p })), clusterIP: it.headless ? "None" : "10.0.0.1" },
    })),
  });
}

describe("pickOpenSearchService", () => {
  test("名字含 opensearch 自动发现，优选 9200 端口", () => {
    const r = pickOpenSearchService(svcList([
      { ns: "kube-system", name: "kube-dns", ports: [53] },
      { ns: "obs", name: "opensearch-cluster", ports: [9600, 9200] },
    ]));
    expect(r).toEqual({ ok: true, value: { namespace: "obs", name: "opensearch-cluster", port: 9200 } });
  });
  test("--service 精确匹配", () => {
    const r = pickOpenSearchService(svcList([{ ns: "obs", name: "my-es", ports: [9200] }]), "my-es");
    expect(r.ok).toBe(true);
  });
  test("自动发现跳过 headless 孪生，--service 点名仍可选中", () => {
    const list = svcList([
      { ns: "obs", name: "opensearch-cluster-master", ports: [9200] },
      { ns: "obs", name: "opensearch-cluster-master-headless", ports: [9200], headless: true },
    ]);
    const auto = pickOpenSearchService(list);
    expect(auto).toEqual({ ok: true, value: { namespace: "obs", name: "opensearch-cluster-master", port: 9200 } });
    expect(pickOpenSearchService(list, "opensearch-cluster-master-headless").ok).toBe(true);
  });
  test("多候选不静默选", () => {
    const r = pickOpenSearchService(svcList([
      { ns: "a", name: "opensearch", ports: [9200] },
      { ns: "b", name: "opensearch-master", ports: [9200] },
    ]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("a/opensearch:9200");
  });
  test("零候选给出指引", () => {
    const r = pickOpenSearchService(svcList([{ ns: "a", name: "mysql", ports: [3306] }]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("--endpoint");
  });
});

describe("countSpans / downloadSpans", () => {
  test("count 使用 traceID term 查询", async () => {
    const calls: Array<{ index: string; query: Record<string, unknown> }> = [];
    const search: SearchEngine = {
      count: async (index, query) => {
        calls.push({ index, query });
        return 7;
      },
      search: async () => ({}),
    };
    const n = await countSpans(search, "jaeger-span-*", "t1");
    expect(n).toBe(7);
    expect(calls).toEqual([{ index: "jaeger-span-*", query: { term: { traceID: "t1" } } }]);
  });

  test("search_after 分页推进直到不满一页", async () => {
    const hit = (i: number) => ({ _source: { spanID: `s${i}` }, sort: [i, `s${i}`] });
    const pages = [
      { hits: { hits: [hit(1), hit(2)] } },
      { hits: { hits: [hit(3)] } },
    ];
    const payloads: any[] = [];
    let call = 0;
    const search: SearchEngine = {
      count: async () => 0,
      search: async (_index, body) => {
        payloads.push(body);
        return pages[call++]!;
      },
    };
    const got: string[] = [];
    const total = await downloadSpans(search, "idx", "t1", 2, (srcs) => {
      for (const s of srcs) got.push(String(s.spanID));
    });
    expect(total).toBe(3);
    expect(got).toEqual(["s1", "s2", "s3"]);
    expect(payloads[0].search_after).toBeUndefined();
    expect(payloads[1].search_after).toEqual([2, "s2"]); // 上一页末条 sort 值接力
    expect(payloads[0].sort).toEqual([{ startTimeMillis: { order: "asc" } }, { spanID: { order: "asc" } }]);
  });

  test("search engine 错误向上抛出", async () => {
    const search: SearchEngine = {
      count: async () => { throw new Error("HTTP 403"); },
      search: async () => ({}),
    };
    expect(countSpans(search, "idx", "t1")).rejects.toThrow("HTTP 403");
  });
});

describe("resolveTraceId", () => {
  test("trace_id 直查命中即返回，不再 tag 反查", async () => {
    let searches = 0;
    const search: SearchEngine = {
      count: async () => 3,
      search: async () => {
        searches += 1;
        return {};
      },
    };
    const r = await resolveTraceId(search, "idx", "t1");
    expect(r).toEqual({ traceId: "t1", resolvedAs: "trace_id" });
    expect(searches).toBe(0);
  });

  test("直查未命中时按 tag 值反查，取最近活跃 trace", async () => {
    const payloads: any[] = [];
    const search: SearchEngine = {
      count: async () => 0,
      search: async (index, body) => {
        payloads.push({ index, body });
        return {
        aggregations: {
          t: {
            buckets: [
              { key: "trace-new", doc_count: 2, m: { value: 2000 } },
              { key: "trace-old", doc_count: 5, m: { value: 1000 } },
            ],
          },
        },
        };
      },
    };
    const r = await resolveTraceId(search, "idx", "msg-1");
    expect(r?.resolvedAs).toBe("tag");
    expect(r?.traceId).toBe("trace-new");
    expect(r?.candidates?.length).toBe(2);
    // 反查是 nested tags.value 精确匹配，不限定业务 key
    expect(payloads[0].body.query).toEqual({ nested: { path: "tags", query: { term: { "tags.value": "msg-1" } } } });
  });

  test("两种方式都未命中返回 undefined", async () => {
    const search: SearchEngine = {
      count: async () => 0,
      search: async () => ({ aggregations: { t: { buckets: [] } } }),
    };
    expect(await resolveTraceId(search, "idx", "nope")).toBeUndefined();
  });
});

describe("stats 与 summary", () => {
  test("按 service 累计 + 时间范围 + error span", () => {
    const stats = newTraceStats();
    accumulateStats(stats, [
      { process: { serviceName: "gw" }, startTimeMillis: 1000, duration: 5000, tags: [] },
      { process: { serviceName: "gw" }, startTimeMillis: 1002, duration: 1000, tags: [{ key: "error", value: true }] },
      { process: { serviceName: "agent" }, startTimeMillis: 1001, duration: 2_000_000, tags: [{ key: "otel.status_code", value: "ERROR" }] },
    ]);
    expect(stats.total).toBe(3);
    expect(stats.services).toEqual({ gw: 2, agent: 1 });
    expect(stats.errorSpans).toBe(2);
    expect(stats.minStartMs).toBe(1000);
    expect(stats.maxEndMs).toBe(3001); // 1001 + 2000000µs/1000

    const md = buildTraceSummary({
      traceId: "t1",
      index: "jaeger-span-*",
      channel: "port-forward svc/opensearch（obs）",
      count: 3,
      downloaded: 3,
      stats,
      steps: ["| count | ok |  |"],
    });
    expect(md).toContain("span 总数: 3");
    expect(md).toContain("| gw | 2 |");
    expect(md).toContain("error span 数: 2");
    expect(md).toContain("spans.jsonl");
  });
});

test("defaultTraceBundleName 截短 trace id", () => {
  const name = defaultTraceBundleName("abcdef0123456789abcdef0123456789", new Date(2026, 6, 10, 1, 2, 3));
  expect(name).toBe("doctor-trace-abcdef012345-20260710-010203");
});

describe("trace 输出格式", () => {
  test("默认 html，路径自动补后缀", () => {
    expect(parseTraceOutputFormat(undefined)).toBe("html");
    expect(resolveTraceHtmlPath(undefined, "doctor-trace-t1")).toBe("doctor-trace-t1.html");
    expect(resolveTraceHtmlPath("report", "ignored")).toBe("report.html");
  });

  test("拒绝未知格式和 bundle 后缀", () => {
    expect(() => parseTraceOutputFormat("json")).toThrow("html 或 bundle");
    expect(() => resolveTraceHtmlPath("report.tar.gz", "ignored")).toThrow("不能使用");
  });
});

/**
 * collectTrace 的端到端记账契约。
 *
 * 此前 trace 只有纯函数测试，六条早退路径（svc 定位失败 / port-forward 起不来 /
 * OpenSearch 不可达 / id 解析失败 / id 未命中 / span 数为 0）全部零覆盖——manifest 里
 * 下游几行凭空消失也就没人发现。--host 带 scheme 时跳过 kubectl 与 scheme 探测，
 * 所以只要假一个 SearchEngine 就能把主链路和早退路径都跑到。
 */
describe("collectTrace 记账", () => {
  const OUTCOME_IDS = ["resolve-id", "count", "download", "render-html"];

  function traceOpts(outputDir: string) {
    return {
      id: "abc123",
      index: "jaeger-span-*",
      auth: { username: "u", password: "p" },
      endpoint: "https://os.example:9200",
      pageSize: 100,
      outputDir,
    };
  }

  /**
   * 假 OpenSearch。真实调用序列（见 opensearch.ts:141-170）：
   *   1. resolveTraceId → _count(输入 id) 直查；>0 就当 trace_id 用
   *   2. 未命中 → _search 带 aggs.t 按 span tag 反查
   *   3. countSpans → 再 _count(解析出的 trace_id)
   *   4. downloadSpans → _search 带 sort/search_after
   * 两次 _count 打同一个 URL，用调用序号区分。
   */
  function fakeSearch(routes: {
    /** 反查是否命中；命中则解析出 trace-xyz */
    resolves?: boolean;
    /** 第 2 次 _count（countSpans）的返回；undefined 表示 500 */
    count?: number;
    spans?: unknown[];
  }): SearchEngine {
    let countCalls = 0;
    return {
      count: async () => {
        countCalls += 1;
        // 第 1 次是 resolveTraceId 的直查——总是未命中，逼它走 tag 反查
        if (countCalls === 1) return 0;
        if (routes.count === undefined) throw new Error("HTTP 500: boom");
        return routes.count;
      },
      search: async (_index, body) => {
        if (body.aggs) {
          return {
            aggregations: {
              t: { buckets: routes.resolves ? [{ key: "trace-xyz", doc_count: 1, m: { value: 1 } }] : [] },
            },
          };
        }
        return { hits: { hits: (routes.spans ?? []).map((source) => ({ _source: source, sort: [1] })) } };
      },
    };
  }

  function manifestOf(dir: string) {
    return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf-8"));
  }

  test("id 解析不到时，count / download 仍在 manifest 里有交代", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-trace-"));
    const code = await collectTrace(traceOpts(dir), () => {}, fakeSearch({ resolves: false }));
    expect(code).toBe(1);
    const steps: any[] = manifestOf(dir).steps;
    const byId = new Map(steps.map((s) => [s.id, s]));
    // 以前这条路径 manifest 里只有 resolve-id，count/download 直接消失
    for (const id of OUTCOME_IDS) expect(byId.has(id)).toBe(true);
    expect(byId.get("resolve-id")).toMatchObject({ status: "failed" });
    expect(byId.get("count")).toMatchObject({ status: "unavailable" });
    expect(byId.get("download")).toMatchObject({ status: "unavailable" });
    // 原因来自早退点，不是 writeManifest 的兜底文案
    expect(byId.get("count")!.reason).toContain("id 未解析到 trace");
  });

  test("span 数为 0 时，download 有交代且原因说得清", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-trace-"));
    const code = await collectTrace(traceOpts(dir), () => {}, fakeSearch({ resolves: true, count: 0 }));
    expect(code).toBe(1);
    const byId = new Map(manifestOf(dir).steps.map((s: any) => [s.id, s]));
    expect(byId.get("count")).toMatchObject({ status: "ok" });
    // 以前 manifest 最后一行是 count=ok，download 行不存在——机器消费方无法区分
    // "下载没跑"和"跑了没记"
    expect(byId.get("download")).toMatchObject({ status: "unavailable" });
    expect((byId.get("download") as any).reason).toContain("span 总数为 0");
  });

  test("count 查询失败时，download 有交代", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-trace-"));
    const code = await collectTrace(traceOpts(dir), () => {}, fakeSearch({ resolves: true }));
    expect(code).toBe(1);
    const byId = new Map(manifestOf(dir).steps.map((s: any) => [s.id, s]));
    expect(byId.get("count")).toMatchObject({ status: "failed" });
    expect(byId.get("download")).toMatchObject({ status: "unavailable" });
  });

  test("成功路径：三格齐全，且没有用到 writeManifest 的兜底文案", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-trace-"));
    const code = await collectTrace(
      traceOpts(dir),
      () => {},
      fakeSearch({ resolves: true, count: 1, spans: [{ traceID: "trace-xyz", spanID: "s1", operationName: "op" }] }),
    );
    expect(code).toBe(0);
    const steps: any[] = manifestOf(dir).steps;
    const byId = new Map(steps.map((s) => [s.id, s]));
    for (const id of OUTCOME_IDS) expect(byId.get(id)).toMatchObject({ status: "ok" });
    // 兜底文案出现 = 有代码路径漏了记账
    expect(steps.filter((s) => s.reason === OUTCOME_UNREACHED_REASON)).toEqual([]);
    // id 不重复
    const ids = steps.map((s) => s.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    const html = readFileSync(join(dir, "trace.html"), "utf-8");
    expect(html).toContain("调用栈");
    expect(html).toContain("火焰图");
  });
});
