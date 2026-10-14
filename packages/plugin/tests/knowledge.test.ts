import { conceptToMarkdown, dictionaryToMarkdown, entryToMarkdown, knowledgeToMarkdown, stepToMarkdown, workflowToMarkdown } from "../src";
import { expect, test } from "bun:test";
import { createServiceCatalog, validateKnowledgeDeclaration, validateExtensionRegistration, type ServiceDefinition } from "../src";

test("Knowledge validates dynamic declarations and common identity/hierarchy invariants", () => {
  expect(() => validateKnowledgeDeclaration({ markdown: () => "", concepts: "legacy text" })).toThrow("must be an array");
  expect(() => validateKnowledgeDeclaration({ markdown: () => "", dictionaries: [{ markdown: () => "", id: "errors", title: "Errors", summary: "", entries: [{ id: "001", name: "Busy" }] }] })).toThrow("description");
  const concept = { markdown() { return conceptToMarkdown(this); }, id: "job", name: "Job", description: "" };
  expect(() => validateKnowledgeDeclaration({ markdown: () => "", concepts: [concept, concept] })).toThrow("duplicate");
  expect(() => validateKnowledgeDeclaration({ markdown: () => "", workflows: [{ markdown() { return workflowToMarkdown(this); }, id: "run", title: "Run", summary: "", steps: [
    { markdown() { return stepToMarkdown(this); }, id: "child", parentId: "missing", title: "Child", description: "" },
  ] }] })).toThrow();
  expect(() => validateKnowledgeDeclaration({ markdown: () => "", workflows: [{ markdown() { return workflowToMarkdown(this); }, id: "run", title: "Run", summary: "", steps: [
    { markdown() { return stepToMarkdown(this); }, id: "a", parentId: "b", title: "A", description: "" },
    { markdown() { return stepToMarkdown(this); }, id: "b", parentId: "a", title: "B", description: "" },
  ] }] })).toThrow();
  const entry = { markdown() { return entryToMarkdown(this); }, id: "001", name: "Busy", description: "HTTP default: 503", defaultHttpStatus: 503 };
  const knowledge = { markdown() { return knowledgeToMarkdown(this); }, dictionaries: [{ markdown() { return dictionaryToMarkdown(this); }, id: "errors", title: "Errors", summary: "", entries: [entry] }] };
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


test("Knowledge loading requires Markdown methods on every content object without invoking them", () => {
  let calls = 0;
  const markdown = () => { calls++; return "custom"; };
  const knowledge = {
    markdown,
    concepts: [{ id: "concept", name: "Concept", description: "", markdown }],
    workflows: [{ id: "flow", title: "Flow", summary: "", markdown,
      steps: [{ id: "step", title: "Step", description: "", markdown }] }],
    articles: [{ id: "article", title: "Article", summary: "", markdown,
      sections: [{ id: "section", title: "Section", body: "", markdown }] }],
    dictionaries: [{ id: "terms", title: "Terms", summary: "", markdown,
      entries: [{ id: "entry", name: "Entry", description: "", markdown }] }],
  };
  validateKnowledgeDeclaration(knowledge);
  expect(calls).toBe(0);
  const objects = [knowledge, knowledge.concepts[0]!, knowledge.workflows[0]!, knowledge.workflows[0]!.steps[0]!,
    knowledge.articles[0]!, knowledge.articles[0]!.sections[0]!, knowledge.dictionaries[0]!, knowledge.dictionaries[0]!.entries[0]!];
  for (const object of objects) {
    Object.assign(object, { markdown: undefined });
    expect(() => validateKnowledgeDeclaration(knowledge)).toThrow("markdown must be a function");
    Object.assign(object, { markdown });
  }
  expect(() => validateKnowledgeDeclaration(JSON.parse(JSON.stringify(knowledge)))).toThrow("restore methods");
  expect(calls).toBe(0);
});
