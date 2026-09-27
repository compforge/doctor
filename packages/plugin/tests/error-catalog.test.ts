import { describe, expect, test } from "bun:test";
import { loadErrorCatalog, requireErrorCatalogExtension, type ErrorCatalogExtension } from "../src/extension/error-catalog";

const definition = { code: "001", name: "QueueBusy", description: "Queue capacity reached" };
const catalog = { source: { name: "api", version: "1.2.3" }, errors: [definition] };
function extension(value: unknown): ErrorCatalogExtension {
  return { id: "errors", kind: "error.catalog", load: () => value } as ErrorCatalogExtension;
}

describe("offline error.catalog contract", () => {
  test("preserves opaque codes, aliases and explicit defaults without inference", () => {
    const value = { ...definition, aliases: ["QueueFull"], exception: "QueueBusyError",
      defaultMessage: "Try later", defaultHttpStatus: 503, defaultDisposition: "retryable",
      references: ["https://example.test/errors"] };
    expect(loadErrorCatalog(extension({ ...catalog, errors: [value] })).errors).toEqual([value]);
    expect(loadErrorCatalog(extension(catalog)).errors[0]).toEqual(definition);
  });
  test("accepts empty catalogs and different names sharing the same code", () => {
    expect(loadErrorCatalog(extension({ ...catalog, errors: [] })).errors).toEqual([]);
    expect(loadErrorCatalog(extension({ ...catalog, errors: [definition, { ...definition, name: "CapacityExceeded" }] })).errors).toHaveLength(2);
  });
  test("rejects duplicate names instead of silently losing definitions", () => {
    expect(() => loadErrorCatalog(extension({ ...catalog, errors: [definition, definition] }))).toThrow("duplicate error name");
  });
  test.each([
    [null, "must be an object"],
    [{ ...catalog, source: { name: "api" } }, "source.version"],
    [{ ...catalog, errors: {} }, "errors must be an array"],
    [{ ...catalog, errors: [{ ...definition, code: 1 }] }, "code must be"],
    [{ ...catalog, errors: [{ ...definition, description: " " }] }, "description must be"],
    [{ ...catalog, errors: [{ ...definition, aliases: [1] }] }, "aliases[0]"],
    [{ ...catalog, errors: [{ ...definition, defaultHttpStatus: 600 }] }, "defaultHttpStatus"],
    [{ ...catalog, errors: [{ ...definition, defaultHttpStatus: 200.5 }] }, "defaultHttpStatus"],
  ])("rejects malformed catalog %#", (value, message) => {
    expect(() => loadErrorCatalog(extension(value))).toThrow(message as string);
  });
  test("requires the right kind and callable loader", () => {
    expect(requireErrorCatalogExtension(extension(catalog)).kind).toBe("error.catalog");
    expect(() => requireErrorCatalogExtension({ id: "errors", kind: "error.catalog" })).toThrow("invalid error.catalog");
    expect(() => requireErrorCatalogExtension({ ...extension(catalog), kind: "case.catalog" })).toThrow("invalid error.catalog");
  });
});
