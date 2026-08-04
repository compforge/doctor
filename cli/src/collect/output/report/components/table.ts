import { escapeHtml, serializeInlineJson } from "./content";
import type { HtmlTableCell, HtmlTableOptions } from "../model";

interface HtmlTablePayload {
  pageSize: number;
  searchColumn?: number;
  headers: Array<{ display: string; sortType: "number" | "text" }>;
  rows: Array<Array<{ display: string; sortValue: string | number }>>;
}

const HTML_TABLE_PAGE_SIZE = 10;

export function htmlTableCell(display: unknown, sortValue: string | number): HtmlTableCell {
  return { display, sortValue };
}

function isHtmlTableCell(value: unknown): value is HtmlTableCell {
  return typeof value === "object" && value !== null && "display" in value && "sortValue" in value;
}

function tableCell(value: unknown): { display: unknown; sortValue: string | number; numeric: boolean } {
  const cell = isHtmlTableCell(value)
    ? value
    : { display: value, sortValue: typeof value === "number" ? value : String(value ?? "") };
  const numeric = typeof cell.sortValue === "number" && Number.isFinite(cell.sortValue);
  return { ...cell, numeric };
}

function isMissingTableValue(value: unknown): boolean {
  return value === undefined || value === null || value === "" || value === "-" || value === "—";
}

export function htmlTable(
  headers: readonly unknown[],
  rows: readonly (readonly unknown[])[],
  options: HtmlTableOptions = {},
): string {
  if (!rows.length) return "";
  const cells = rows.map((row) => row.map(tableCell));
  const payload: HtmlTablePayload = {
    pageSize: HTML_TABLE_PAGE_SIZE,
    searchColumn: options.search?.column,
    headers: headers.map((value, column) => {
      const columnCells = cells.map((row) => row[column]).filter((cell) => cell !== undefined);
      const numeric = columnCells.some((cell) => cell.numeric)
        && columnCells.every((cell) => cell.numeric || isMissingTableValue(cell.display));
      return { display: String(value), sortType: numeric ? "number" : "text" };
    }),
    rows: cells.map((row) => row.map((cell) => ({
      display: String(cell.display),
      sortValue: cell.numeric ? cell.sortValue : String(cell.sortValue),
    }))),
  };
  const search = options.search
    ? `<label class="table-search-label"><span>检索</span><input class="table-search" type="search" placeholder="${escapeHtml(options.search.placeholder ?? "检索")}" aria-label="${escapeHtml(options.search.placeholder ?? "检索")}"></label>`
    : "";
  return `<details class="table-view"><summary><span>查看表格</span>${search}<span class="table-summary-meta">${rows.length} 条 · ${headers.length} 列</span></summary><script type="application/json" class="table-data">${serializeInlineJson(payload)}</script><div class="table-mount"></div><div class="table-controls" hidden><label>每页 <select class="table-page-size" aria-label="每页行数"><option value="10">10</option><option value="20">20</option><option value="50">50</option><option value="0">全部</option></select> 条</label><span class="table-page-info"></span><button type="button" class="table-page-previous">上一页</button><button type="button" class="table-page-next">下一页</button></div></details>`;
}
