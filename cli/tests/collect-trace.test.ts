import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Detector } from "@compforge/trace-harness";
import { OUTCOME_UNREACHED_REASON } from "../src/collect/evidence";
import type { SearchEngine } from "../src/infra/search";
import { pickOpenSearchService } from "../src/infra/search/opensearch";
import {
  buildIndexExpr,
  countSpans,
  downloadSpans,
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
      traceId: "abc123",
      bizId: "message-1",
      traceIdResolution: { service: "example-api", resolvedAs: "request_id" },
      index: "jaeger-span-*",
      auth: { username: "u", password: "p" },
      endpoint: "https://os.example:9200",
      pageSize: 100,
      outputDir,
    };
  }

  function fakeSearch(routes: {
    /** _count（countSpans）的返回；undefined 表示 500 */
    count?: number;
    spans?: unknown[];
  }): SearchEngine {
    return {
      count: async () => {
        if (routes.count === undefined) throw new Error("HTTP 500: boom");
        return routes.count;
      },
      search: async () => ({
        hits: { hits: (routes.spans ?? []).map((source) => ({ _source: source, sort: [1] })) },
      }),
    };
  }

  function manifestOf(dir: string) {
    return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf-8"));
  }

  test("span 数为 0 时，download 有交代且原因说得清", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-trace-"));
    const code = await collectTrace(traceOpts(dir), () => {}, fakeSearch({ count: 0 }));
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
    const code = await collectTrace(traceOpts(dir), () => {}, fakeSearch({}));
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
      fakeSearch({ count: 1, spans: [{ traceID: "abc123", spanID: "s1", operationName: "op" }] }),
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

  test("Plugin trace analysis 只注入本次 TraceHarness", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-trace-"));
    const pluginDetector: Detector = (node) => [{
      ref: node.node_id,
      source: "test-plugin",
      severity: "warn",
      note: "plugin-scoped-finding",
    }];
    const code = await collectTrace(
      { ...traceOpts(dir), contributions: { detectors: [pluginDetector] } },
      () => {},
      fakeSearch({ count: 1, spans: [{ traceID: "abc123", spanID: "s1", operationName: "op" }] }),
    );

    expect(code).toBe(0);
    expect(readFileSync(join(dir, "trace.html"), "utf-8")).toContain("plugin-scoped-finding");
  });
});
