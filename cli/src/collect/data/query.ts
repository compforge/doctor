import type { CollectDataCliOpts } from "./model";

export function parseDataQueries(opts: CollectDataCliOpts) {
  if (opts.bizTypes?.some(type => !type.trim())) throw new Error("biz-type 必须非空");
  const ids = [...new Set((opts.bizIds ?? []).map(value => value.trim()).filter(Boolean))];
  const bizTypes = [...new Set((opts.bizTypes ?? []).map(value => value.trim()).filter(Boolean))];
  if (opts.tenantId !== undefined && !opts.tenantId.trim()) throw new Error("tenantId 必须非空");
  if (opts.tenantId !== undefined && ids.length) throw new Error("租户查询只支持 biz-type");
  if (!ids.length && !bizTypes.length && !opts.tenantId) throw new Error("doctor data 需要至少一个 biz-id");
  const { page, pageSize } = parseDataPagination(opts);
  if (!bizTypes.length && !opts.tenantId && (opts.page !== undefined || opts.pageSize !== undefined)) throw new Error("分页参数需要 --biz-type");
  return { ids, ...(bizTypes.length || opts.tenantId ? { list: { bizTypes, page, pageSize } } : {}) };
}


export function parseDataPagination(opts: Pick<CollectDataCliOpts, "page" | "pageSize">) {
  const integer = (value: string | number | undefined, fallback: number, name: string) => {
    const parsed = value === undefined ? fallback : Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} 必须为正整数`);
    return parsed;
  };
  const page = integer(opts.page, 1, "--page");
  const pageSize = integer(opts.pageSize, 20, "--page-size");
  if (pageSize > 1000 || !Number.isSafeInteger((page - 1) * pageSize)) throw new Error("分页范围超出限制（page-size 最大 1000）");
  return { page, pageSize };
}
