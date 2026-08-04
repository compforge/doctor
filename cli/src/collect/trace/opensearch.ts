import type { SearchEngine } from "../../infra/search";

/** --index 显式最优先；--index-date 是 jaeger-span-<date> 的便捷写法；缺省通配跨日期查 */
export function buildIndexExpr(index?: string, indexDate?: string): string {
  if (index) return index;
  if (indexDate) return `jaeger-span-${indexDate}`;
  return "jaeger-span-*";
}

function termQuery(traceId: string): Record<string, unknown> {
  return { term: { traceID: traceId } };
}

/** _count 先行：既是连通性/鉴权验证，也决定后续下载是否有必要 */
export async function countSpans(
  search: SearchEngine,
  index: string,
  traceId: string,
): Promise<number> {
  return search.count(index, termQuery(traceId));
}

export interface ResolvedTrace {
  traceId: string;
  /** trace_id=输入本身就是 trace；tag=经 span tag 值反查（message_id/conversation_id 等） */
  resolvedAs: "trace_id" | "tag";
  /** tag 反查时命中的全部候选 trace（按最近活跃倒序），第一个即选中项 */
  candidates?: Array<{ traceId: string; lastSeenMs: number; spanHits: number }>;
}

/**
 * 任意 id → trace_id（对齐 trace-as resolve 的语义，但通道业务无关）：
 * 1. 先当 trace_id 直查（term traceID）；
 * 2. 未命中则按 span tag **值**反查（nested tags.value term，不限定 key）——
 *    message_id / conversation_id / task_id 等只要进过 span tag 都能命中，
 *    无需维护业务 key 台账；多候选 trace 时选最近活跃的一条（与 trace-as
 *    chat_db「会话取最新一条 message 的 trace」语义一致），其余进 candidates。
 * 返回 undefined = 两种方式都未命中。
 */
export async function resolveTraceId(
  search: SearchEngine,
  index: string,
  id: string,
): Promise<ResolvedTrace | undefined> {
  if ((await countSpans(search, index, id)) > 0) {
    return { traceId: id, resolvedAs: "trace_id" };
  }
  const payload = {
    size: 0,
    query: { nested: { path: "tags", query: { term: { "tags.value": id } } } },
    aggs: {
      t: {
        terms: { field: "traceID", size: 10, order: { m: "desc" } },
        aggs: { m: { max: { field: "startTimeMillis" } } },
      },
    },
  };
  const result = await search.search(index, payload);
  const buckets = ((result.aggregations as any)?.t?.buckets ?? []) as Array<Record<string, any>>;
  if (!buckets.length) return undefined;
  const candidates = buckets.map((b) => ({
    traceId: String(b.key),
    lastSeenMs: Number(b.m?.value ?? 0),
    spanHits: Number(b.doc_count ?? 0),
  }));
  return { traceId: candidates[0]!.traceId, resolvedAs: "tag", candidates };
}

/** search_after 分页拉全量 span，每页把 hits 的 _source 交给 onPage；返回实际下载条数 */
export async function downloadSpans(
  search: SearchEngine,
  index: string,
  traceId: string,
  pageSize: number,
  onPage: (sources: Record<string, unknown>[]) => void,
): Promise<number> {
  let total = 0;
  let searchAfter: unknown = undefined;
  for (;;) {
    const payload: Record<string, unknown> = {
      size: pageSize,
      track_total_hits: true,
      sort: [{ startTimeMillis: { order: "asc" } }, { spanID: { order: "asc" } }],
      query: termQuery(traceId),
    };
    if (searchAfter !== undefined) payload.search_after = searchAfter;
    const result = await search.search(index, payload);
    const hits = ((result.hits as Record<string, unknown> | undefined)?.hits ?? []) as Array<Record<string, unknown>>;
    if (!hits.length) break;
    onPage(hits.map((h) => (h._source ?? {}) as Record<string, unknown>));
    total += hits.length;
    searchAfter = hits[hits.length - 1]!.sort;
    if (hits.length < pageSize) break;
  }
  return total;
}
