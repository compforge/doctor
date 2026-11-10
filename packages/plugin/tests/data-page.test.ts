import { expect, test } from "bun:test";
import { dataPageOutput, requireDataPageExtension, withSummary } from "../src";
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
