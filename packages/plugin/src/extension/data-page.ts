import type { Extension, RegisteredExtension } from "./index";

export const DATA_PAGE_KIND = "data.page";

export interface DataPageQuery {
  /** When provided, both items and total must be restricted to this tenant. */
  tenantId?: string;
  page: number;
  pageSize: number;
  /** Bound the sum of item JSON bytes at the source; page metadata is excluded. The host enforces this too. */
  maxBytes: number;
}

export interface DataPage<T = unknown> {
  items: readonly T[];
  page: number;
  pageSize: number;
  /** Exact count for the same scope as items, before pagination. */
  total: number;
  /** A resource budget may shorten a page, never masquerade as its natural end. */
  truncated?: { reason: string };
}

/** @spec Each Service registers one provider per business type; record fields belong to the Service. */
export interface DataPageExtension<T = unknown> extends Extension<DataPageQuery, DataPage<T>> {
  readonly kind: typeof DATA_PAGE_KIND;
  readonly bizType: string;
  /** Explicit opt-in; hosts must never send tenant queries to unscoped providers. */
  readonly supportsTenant?: boolean;
  readonly description: string;
}

export function requireDataPageExtension(extension: RegisteredExtension): DataPageExtension {
  if (extension.kind !== DATA_PAGE_KIND) throw new Error(`Expected ${DATA_PAGE_KIND}, got ${extension.kind}`);
  const item = extension as unknown as Record<string, unknown>;
  for (const field of ["bizType", "description"] as const) {
    if (typeof item[field] !== "string" || !item[field].trim() || item[field] !== item[field].trim()) {
      throw new Error(`${extension.id}.${field} must be a non-empty, trimmed string`);
    }
  }
  if (item.supportsTenant !== undefined && typeof item.supportsTenant !== "boolean") throw new Error(`${extension.id}.supportsTenant must be a boolean`);
  return extension as DataPageExtension;
}

/** Validate page arithmetic before a provider uses the offset with its data source. */
export function pageOffset(query: Pick<DataPageQuery, "page" | "pageSize">): number {
  const offset = (query.page - 1) * query.pageSize;
  if (!Number.isSafeInteger(query.page) || query.page < 1 || !Number.isSafeInteger(query.pageSize)
    || query.pageSize < 1 || !Number.isSafeInteger(offset)) throw new Error("Invalid pagination");
  return offset;
}

/** Normalize a source count without treating missing values as an empty collection. */
export function pageTotal(value: unknown): number {
  if (typeof value !== "number" && typeof value !== "bigint" && (typeof value !== "string" || !value.trim())) {
    throw new Error("Count is unavailable or invalid");
  }
  const total = Number(value);
  if (!Number.isSafeInteger(total) || total < 0) throw new Error("Count is unavailable or invalid");
  return total;
}

/** Validate the pagination contract without interpreting Service-owned records. */
export function dataPageOutput(value: unknown, query: DataPageQuery): DataPage {
  if (!value || typeof value !== "object") throw new Error("data.page must return a page");
  const page = value as DataPage;
  if (!Array.isArray(page.items) || page.items.length > query.pageSize
    || page.page !== query.page || page.pageSize !== query.pageSize
    || !Number.isSafeInteger(page.total) || page.total < 0) {
    throw new Error("data.page returned invalid items/page/pageSize/total");
  }
  if (page.truncated !== undefined && (!page.truncated || typeof page.truncated.reason !== "string" || !page.truncated.reason.trim())) {
    throw new Error("data.page truncation requires a reason");
  }
  return page;
}

/** @spec Keep a stable prefix within the item byte budget; truncation never changes source counts or pagination. */
export function boundDataPage<T>(page: DataPage<T>, maxBytes: number): DataPage<T> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Invalid data page byte budget");
  let bytes = 0;
  const items: T[] = [];
  for (const item of page.items) {
    const size = Buffer.byteLength(JSON.stringify(item), "utf8");
    if (bytes + size > maxBytes) return { ...page, items, truncated: page.truncated ?? { reason: "Data page byte budget exceeded" } };
    bytes += size;
    items.push(item);
  }
  return page;
}
