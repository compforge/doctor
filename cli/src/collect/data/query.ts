import type { CollectDataCliOpts } from "./model";

export function parseDataQueries(opts: CollectDataCliOpts) {
  const ids = [...new Set((opts.bizIds ?? []).map(value => value.trim()).filter(Boolean))];
  const bizTypes = [...new Set((opts.bizTypes ?? []).map(value => value.trim()).filter(Boolean))];
  if (!ids.length && !bizTypes.length) throw new Error("doctor data 需要至少一个 biz-id 或 biz-type");
  const integer = (value: string | number | undefined, fallback: number, name: string) => {
    const parsed = value === undefined ? fallback : Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} 必须为正整数`);
    return parsed;
  };
  const page = integer(opts.page, 1, "--page");
  const pageSize = integer(opts.pageSize, 20, "--page-size");
  if (pageSize > 1000 || !Number.isSafeInteger((page - 1) * pageSize)) throw new Error("分页范围超出限制（page-size 最大 1000）");
  if (!bizTypes.length && (opts.page !== undefined || opts.pageSize !== undefined)) throw new Error("分页参数需要 --biz-type");
  return { ids, ...(bizTypes.length ? { list: { bizTypes, page, pageSize } } : {}) };
}

