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
