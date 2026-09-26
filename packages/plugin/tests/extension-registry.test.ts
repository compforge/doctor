import { expect, test } from "bun:test";
import { ExtensionRegistry, extensionNamespace, validateExtensionNamespace } from "../src/extension";

test("Core and Plugin register through one kind-indexed extension registry", () => {
  const registry = new ExtensionRegistry();
  registry.register("core", [{ id: "cases", kind: "case.catalog" }]);
  registry.register("plugin/fixture", [{ id: "cases", kind: "case.catalog" }, { id: "other", kind: "other.kind" }]);
  expect(registry.extensions("case.catalog").map((item) => item.namespace)).toEqual(["core", "plugin/fixture"]);
  expect(registry.extensions("other.kind")).toHaveLength(1);
  expect(() => registry.register("core", [{ id: "cases", kind: "other.kind" }])).toThrow("duplicate");
});

test("namespace filters never inherit, merge or override a parent or sibling", () => {
  const registry = new ExtensionRegistry();
  const extension = { id: "errors", kind: "overview.summarize" };
  const namespaces = ["core", "local", "plugin/example", "plugin/example/service/api", "plugin/other/service/api"];
  for (const namespace of namespaces) registry.register(namespace, [extension]);
  expect(registry.extensions(extension.kind).map(item => item.namespace)).toEqual(namespaces);
  expect(registry.extensions(extension.kind, "plugin/example")).toEqual([{ namespace: "plugin/example", extension }]);
  expect(registry.extensions(extension.kind, "plugin/example/service/api")).toEqual([{ namespace: "plugin/example/service/api", extension }]);
  expect(registry.extensions(extension.kind, "plugin/missing")).toEqual([]);
  expect(registry.extensions("other.kind", "plugin/example")).toEqual([]);
  expect(() => registry.register("plugin/example", [{ ...extension, kind: "overview.sample" }])).toThrow("duplicate");
});

test("namespace syntax is validated on registration and discovery without normalization", () => {
  const registry = new ExtensionRegistry();
  for (const namespace of ["", " ", "/core", "core/", "plugin//api", "plugin/../api", "plugin/./api", "plugin:api", "plugin/my app", " core", "core\n"]) {
    expect(() => validateExtensionNamespace(namespace)).toThrow();
    expect(() => registry.register(namespace, [])).toThrow();
    expect(() => registry.extensions("overview.summarize", namespace)).toThrow();
  }
  expect(extensionNamespace("plugin", "Example_v1.2", "service", "api-server")).toBe("plugin/Example_v1.2/service/api-server");
  expect(() => extensionNamespace()).toThrow();
  expect(() => extensionNamespace("plugin", "example/service/api")).toThrow();
  expect(() => extensionNamespace("plugin", "")).toThrow();
  registry.register("plugin/Example", [{ id: "errors", kind: "overview.summarize" }]);
  expect(registry.extensions("overview.summarize", "plugin/example")).toEqual([]);
});


test("an Extension declares its scope independently of the registration default", () => {
  const registry = new ExtensionRegistry();
  const product = { id: "errors", kind: "overview.summarize", namespace: "plugin/example" };
  const local = { id: "errors", kind: "overview.summarize" };
  const registered = registry.register("plugin/example/service/api", [product, local]);
  expect(registered.map(item => item.namespace)).toEqual(["plugin/example", "plugin/example/service/api"]);
  expect(registry.extensions(product.kind, "plugin/example")).toEqual([{ namespace: "plugin/example", extension: product }]);
  expect(() => registry.register("plugin/example/service/worker", [product])).toThrow("duplicate");
  expect(() => registry.register("core", [{ ...product, namespace: "plugin//invalid" }])).toThrow("namespace");
});
