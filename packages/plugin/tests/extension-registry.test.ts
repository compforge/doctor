import { expect, test } from "bun:test";
import { ExtensionRegistry } from "../src/extension";

test("Core and Plugin register through one kind-indexed extension registry", () => {
  const registry = new ExtensionRegistry();
  registry.register("core", [{ id: "cases", kind: "case.catalog" }]);
  registry.register("plugin:fixture", [{ id: "cases", kind: "case.catalog" }, { id: "other", kind: "other.kind" }]);
  expect(registry.extensions("case.catalog").map((item) => item.owner)).toEqual(["core", "plugin:fixture"]);
  expect(registry.extensions("other.kind")).toHaveLength(1);
  expect(() => registry.register("core", [{ id: "cases", kind: "other.kind" }])).toThrow("duplicate");
});
