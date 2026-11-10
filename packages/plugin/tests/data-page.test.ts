import { serializeValue, deserializeValue } from "@compforge/harness-common";
import { PageValue, pageCodec } from "./page-value-fixture";
import { expect, test } from "bun:test";
import { serializeDataPage, dataPageOutput, requireDataPageExtension, withSummary, pageOffset, pageTotal } from "../src";
const query = { page: 3, pageSize: 2, maxBytes: 1000 };
test("data.page requires valid page metadata but leaves Service records opaque", () => {
  const page = { page: 3, pageSize: 2, total: 4, items: [] };
  expect(dataPageOutput(page, query)).toEqual(page);
  expect(dataPageOutput({ ...page, items: [new PageValue({ serviceOwned: true })] }, query).items[0]).toEqual(new PageValue({ serviceOwned: true }));
  for (const invalid of [{ total: -1 }, { total: "4" }, { total: 1.5 }, { page: 1 }, { pageSize: 3 }, { items: [1, 2, 3] }, { truncated: {} }]) {
    expect(() => dataPageOutput({ ...page, ...invalid }, query)).toThrow();
  }
});
test("business type and description are static registration requirements", () => {
  const extension = { id: "bots", kind: "data.page", codec: pageCodec, access: {}, bizType: "bot", description: "Bots", run: withSummary({ title: "Bots", fields: [] }, async () => ({ items: [], page: 1, pageSize: 20, total: 0 })) };
  expect(requireDataPageExtension(extension).bizType).toBe("bot");
  const invalid = { ...extension, bizType: " " };
  expect(() => requireDataPageExtension(invalid)).toThrow();
  expect(() => requireDataPageExtension({ ...extension, kind: "data.id" })).toThrow();
});

test("tenant filtering support is explicit registration metadata", () => {
  const extension = { id: "bots", kind: "data.page", codec: pageCodec, access: {}, bizType: "bot", description: "Bots", supportsTenant: true,
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


test("page serialization uses codec projections, preserves summaries and rejects aggregate overflow", () => {
  const first = new PageValue({ name: "中文" });
  const serialized = serializeValue(first, pageCodec);
  const budget = Buffer.byteLength(JSON.stringify(serialized), "utf8");
  const page = { items: [first], page: 2, pageSize: 2, total: 17, truncated: { reason: "Service field projection" } };
  const output = serializeDataPage(page, pageCodec, budget);
  expect(output).toEqual({ ...page, items: [serialized] });
  expect(deserializeValue(output.items[0]!.data, pageCodec).summary()).toEqual(first.summary());
  expect(() => serializeDataPage(page, pageCodec, budget - 1)).toThrow("byte budget");
  expect(() => serializeDataPage({ ...page, items: [first, first] }, pageCodec, budget)).toThrow("byte budget");
  expect(page.items).toEqual([first]);
  expect(serializeDataPage({ ...page, items: [] }, pageCodec, 0).total).toBe(17);
});

test("page serialization validates codecs, values and budgets without silently pruning records", () => {
  const page = { items: [new PageValue({ name: "kept" })], page: 1, pageSize: 2, total: 1 };
  for (const budget of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => serializeDataPage(page, pageCodec, budget)).toThrow("Invalid data page byte budget");
  }
  const invalid = { ...pageCodec, decode: () => { throw new Error("bad record"); } };
  expect(() => serializeDataPage(page, invalid, 1000)).toThrow("bad record");
  expect(() => dataPageOutput({ ...page, items: [{}] }, { ...query, page: 1 })).toThrow("implement Value");
  const extension = { id: "records", kind: "data.page", bizType: "record", description: "Records" };
  expect(() => requireDataPageExtension(extension as never)).toThrow("ValueCodec");
});
