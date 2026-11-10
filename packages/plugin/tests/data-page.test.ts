import { expect, test } from "bun:test";
import { boundDataPage, dataPageOutput, requireDataPageExtension, withSummary, pageOffset, pageTotal } from "../src";
const query = { page: 3, pageSize: 2, maxBytes: 1000 };
test("data.page requires valid page metadata but leaves Service records opaque", () => {
  const page = { page: 3, pageSize: 2, total: 4, items: [] };
  expect(dataPageOutput(page, query)).toEqual(page);
  expect(dataPageOutput({ ...page, items: [{ serviceOwned: true }] }, query).items).toEqual([{ serviceOwned: true }]);
  for (const invalid of [{ total: -1 }, { total: "4" }, { total: 1.5 }, { page: 1 }, { pageSize: 3 }, { items: [1, 2, 3] }, { truncated: {} }]) {
    expect(() => dataPageOutput({ ...page, ...invalid }, query)).toThrow();
  }
});
test("business type and description are static registration requirements", () => {
  const extension = { id: "bots", kind: "data.page", access: {}, bizType: "bot", description: "Bots", run: withSummary({ title: "Bots", fields: [] }, async () => ({ items: [], page: 1, pageSize: 20, total: 0 })) };
  expect(requireDataPageExtension(extension).bizType).toBe("bot");
  const invalid = { ...extension, bizType: " " };
  expect(() => requireDataPageExtension(invalid)).toThrow();
  expect(() => requireDataPageExtension({ ...extension, kind: "data.id" })).toThrow();
});

test("tenant filtering support is explicit registration metadata", () => {
  const extension = { id: "bots", kind: "data.page", access: {}, bizType: "bot", description: "Bots", supportsTenant: true,
    run: withSummary({ title: "Bots", fields: [] }, async () => ({ items: [], page: 1, pageSize: 20, total: 0 })) };
  expect(requireDataPageExtension(extension).supportsTenant).toBe(true);
  const invalid = { ...extension, supportsTenant: "true" };
  expect(() => requireDataPageExtension(invalid)).toThrow("supportsTenant");
});


test("page offsets reject invalid dimensions and unsafe integer arithmetic", () => {
  expect(pageOffset({ page: 1, pageSize: 20 })).toBe(0);
  expect(pageOffset({ page: 3, pageSize: 20 })).toBe(40);
  for (const query of [{ page: 0, pageSize: 20 }, { page: 1.5, pageSize: 20 },
    { page: 2, pageSize: 0 }, { page: 2, pageSize: 1.5 }, { page: Infinity, pageSize: 20 },
    { page: Number.MAX_SAFE_INTEGER, pageSize: 20 }]) {
    expect(() => pageOffset(query)).toThrow("Invalid pagination");
  }
});

test("page totals accept source numeric representations but never turn missing counts into zero", () => {
  for (const value of [0, "0", 0n]) expect(pageTotal(value)).toBe(0);
  for (const value of [42, "42", 42n]) expect(pageTotal(value)).toBe(42);
  for (const value of [undefined, null, "", " ", false, true, {}, -1, 1.5, "bad", Infinity, NaN,
    Number.MAX_SAFE_INTEGER + 1, 9007199254740993n]) {
    expect(() => pageTotal(value)).toThrow("Count is unavailable or invalid");
  }
});


test("page byte bounds retain a stable UTF-8 prefix and the original pagination", () => {
  const first = { value: "中文" };
  const page = { items: [first, { value: "large".repeat(100) }, { value: "x" }], page: 2, pageSize: 3, total: 17 };
  const budget = Buffer.byteLength(JSON.stringify(first), "utf8");
  expect(boundDataPage(page, budget)).toEqual({ ...page, items: [first], truncated: { reason: expect.any(String) } });
  expect(boundDataPage(page, budget - 1).items).toEqual([]);
  expect(boundDataPage(page, 0).truncated).toBeDefined();
  expect(page.items).toHaveLength(3);
  const fullBudget = page.items.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item), "utf8"), 0);
  expect(boundDataPage(page, fullBudget)).toBe(page);
  const partial = { ...page, truncated: { reason: "Upstream limit" } };
  expect(boundDataPage(partial, budget).truncated).toEqual(partial.truncated);
  expect(boundDataPage({ ...page, items: [] }, 0).truncated).toBeUndefined();
});

test("page byte bounds reject invalid budgets", () => {
  for (const budget of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => boundDataPage({ items: [], page: 1, pageSize: 1, total: 0 }, budget)).toThrow("Invalid data page byte budget");
  }
});
