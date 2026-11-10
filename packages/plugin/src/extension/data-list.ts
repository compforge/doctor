import type { Extension, RegisteredExtension } from "./index";

export const DATA_LIST_KIND = "data.list";

export interface DataListQuery {
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
export interface DataListExtension<T = unknown> extends Extension<DataListQuery, DataPage<T>> {
  readonly kind: typeof DATA_LIST_KIND;
  readonly bizType: string;
  readonly description: string;
}

export function requireDataListExtension(extension: RegisteredExtension): DataListExtension {
  if (extension.kind !== DATA_LIST_KIND) throw new Error(`Expected ${DATA_LIST_KIND}, got ${extension.kind}`);
  const item = extension as unknown as Record<string, unknown>;
  for (const field of ["bizType", "description"] as const) {
    if (typeof item[field] !== "string" || !item[field].trim() || item[field] !== item[field].trim()) {
      throw new Error(`${extension.id}.${field} must be a non-empty, trimmed string`);
    }
  }
  return extension as DataListExtension;
}

/** Validate the pagination contract without interpreting Service-owned records. */
export function dataPageOutput(value: unknown, query: DataListQuery): DataPage {
  if (!value || typeof value !== "object") throw new Error("data.list must return a page");
  const page = value as DataPage;
  if (!Array.isArray(page.items) || page.items.length > query.pageSize
    || page.page !== query.page || page.pageSize !== query.pageSize
    || !Number.isSafeInteger(page.total) || page.total < 0) {
    throw new Error("data.list returned invalid items/page/pageSize/total");
  }
  if (page.truncated !== undefined && (!page.truncated || typeof page.truncated.reason !== "string" || !page.truncated.reason.trim())) {
    throw new Error("data.list truncation requires a reason");
  }
  return page;
}
