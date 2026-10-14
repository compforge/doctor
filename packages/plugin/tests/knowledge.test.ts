import { expect, test } from "bun:test";
import { createServiceCatalog, validateKnowledgeDeclaration, validateExtensionRegistration, type ServiceDefinition } from "../src";

test("Knowledge validates dynamic declarations and common identity/hierarchy invariants", () => {
  expect(() => validateKnowledgeDeclaration({ concepts: "legacy text" })).toThrow("must be an array");
  expect(() => validateKnowledgeDeclaration({ dictionaries: [{ id: "errors", title: "Errors", summary: "", entries: [{ id: "001", name: "Busy" }] }] })).toThrow("description");
  const concept = { id: "job", name: "Job", description: "" };
  expect(() => validateKnowledgeDeclaration({ concepts: [concept, concept] })).toThrow("duplicate");
  expect(() => validateKnowledgeDeclaration({ workflows: [{ id: "run", title: "Run", summary: "", steps: [
    { id: "child", parentId: "missing", title: "Child", description: "" },
  ] }] })).toThrow();
  expect(() => validateKnowledgeDeclaration({ workflows: [{ id: "run", title: "Run", summary: "", steps: [
    { id: "a", parentId: "b", title: "A", description: "" },
    { id: "b", parentId: "a", title: "B", description: "" },
  ] }] })).toThrow();
  const entry = { id: "001", name: "Busy", description: "HTTP default: 503", defaultHttpStatus: 503 };
  const knowledge = { dictionaries: [{ id: "errors", title: "Errors", summary: "", entries: [entry] }] };
  validateKnowledgeDeclaration(knowledge);
  expect(knowledge.dictionaries[0]?.entries[0]).toBe(entry);
});

test("Service upstream preserves undeclared vs empty and rejects malformed lists", () => {
  const service: ServiceDefinition = { name: "worker", component: { name: "worker", repository: { forge: { name: "test" }, path: "app" } }, workloads: [] };
  expect(createServiceCatalog([service]).find("worker")?.upstream).toBeUndefined();
  expect(createServiceCatalog([{ ...service, upstream: [] }]).find("worker")?.upstream).toEqual([]);
  expect(() => createServiceCatalog([{ ...service, upstream: [42] } as never])).toThrow("upstream");
});

test("legacy error Extension directs authors to Knowledge dictionaries", () => {
  expect(() => validateExtensionRegistration({ id: "errors", kind: "error.catalog" })).toThrow("Knowledge.dictionaries");
});
