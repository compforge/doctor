import type { Extension, RegisteredExtension } from "./index";

export const DATA_PAGE_KIND = "data.page";

export interface DataPageQuery {
  /** When provided, both items and total must be restricted to this tenant. */
  tenantId?: string;
  page: number;
  pageSize: number;
  /** Bound the returned JSON at the source; the host enforces this limit too. */
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
