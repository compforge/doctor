import type { SearchEngine } from "@compforge/harness-toolbox/opensearch/types";
import { searchAfterPages } from "@compforge/harness-toolbox/opensearch/search-after";

/** --index 显式最优先；--index-date 是 jaeger-span-<date> 的便捷写法；缺省通配跨日期查 */
export function buildIndexExpr(index?: string, indexDate?: string): string {
  if (index) return index;
  if (indexDate) return `jaeger-span-${indexDate}`;
  return "jaeger-span-*";
}

function termQuery(traceId: string, spanId?: string): Record<string, unknown> {
  const trace = { term: { traceID: traceId } };
  return spanId ? { bool: { filter: [trace, { term: { spanID: spanId } }] } } : trace;
}

/** _count 先行：既是连通性/鉴权验证，也决定后续下载是否有必要 */
export async function countSpans(
  search: SearchEngine,
  index: string,
  traceId: string,
  spanId?: string,
): Promise<number> {
  return search.count(index, termQuery(traceId, spanId));
}

/** search_after 分页拉全量 span，每页把 hits 的 _source 交给 onPage；返回实际下载条数 */
export async function downloadSpans(
  search: SearchEngine,
  index: string,
  traceId: string,
  pageSize: number,
  onPage: (sources: Record<string, unknown>[]) => void,
  spanId?: string,
  signal?: AbortSignal,
): Promise<number> {
  let total = 0;
  for await (const hits of searchAfterPages(search, index, {
    pageSize,
    sort: [{ startTimeMillis: { order: "asc" } }, { spanID: { order: "asc" } }],
    query: termQuery(traceId, spanId),
    signal,
  })) {
    onPage(hits.map(hit => (hit._source ?? {}) as Record<string, unknown>));
    total += hits.length;
  }
  return total;
}
