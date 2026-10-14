import { validateKnowledge, type Knowledge } from "@compforge/harness-common";

export {
  validateKnowledge, validateWorkflow, knowledgeToMarkdown, conceptToMarkdown,
  workflowToMarkdown, stepToMarkdown, articleToMarkdown, sectionToMarkdown,
  dictionaryToMarkdown, entryToMarkdown,
} from "@compforge/harness-common";
export type {
  Knowledge, Concept, Workflow, Step, Article, Section, Dictionary, Entry,
  KnowledgeSource, Markdown,
} from "@compforge/harness-common";

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, nonEmpty = false): void {
  if (typeof value !== "string" || (nonEmpty && !value.trim())) throw new Error(`${label} must be ${nonEmpty ? "a non-empty string" : "a string"}`);
}

function records(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, index) => record(item, `${label}[${index}]`));
}

function strings(value: unknown, label: string): void {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  value.forEach((item, index) => text(item, `${label}[${index}]`, true));
}

function markdown(value: Record<string, unknown>, label: string): void {
  if (typeof value.markdown !== "function") throw new Error(`${label}.markdown must be a function; restore methods after loading JSON`);
}

/** Validate callable Knowledge across installed ESM and injected Plugin boundaries without rendering it. */
export function validateKnowledgeDeclaration(value: unknown, label = "knowledge"): asserts value is Knowledge {
  const knowledge = record(value, label);
  const markdownObjects: { value: Record<string, unknown>; path: string }[] = [{ value: knowledge, path: label }];
  for (const kind of ["concepts", "workflows", "articles", "dictionaries"] as const) {
    if (knowledge[kind] === undefined) continue;
    for (const item of records(knowledge[kind], `${label}.${kind}`)) {
      text(item.id, `${label}.${kind}.id`, true);
      const path = `${label}.${kind}.${String(item.id)}`;
      markdownObjects.push({ value: item, path });
      if (kind === "concepts") {
        text(item.name, `${path}.name`, true);
        text(item.description, `${path}.description`);
        continue;
      }
      text(item.title, `${path}.title`, true);
      text(item.summary, `${path}.summary`);
      if (kind === "workflows") {
        for (const step of records(item.steps, `${path}.steps`)) {
          text(step.id, `${path}.steps.id`, true);
          markdownObjects.push({ value: step, path: `${path}.steps.${String(step.id)}` });
          text(step.title, `${path}.steps.title`, true);
          text(step.description, `${path}.steps.description`);
          if (step.parentId !== undefined) text(step.parentId, `${path}.steps.parentId`, true);
        }
      } else if (kind === "articles") {
        for (const section of records(item.sections, `${path}.sections`)) {
          text(section.id, `${path}.sections.id`, true);
          markdownObjects.push({ value: section, path: `${path}.sections.${String(section.id)}` });
          text(section.title, `${path}.sections.title`, true);
          text(section.body, `${path}.sections.body`);
        }
      } else {
        for (const entry of records(item.entries, `${path}.entries`)) {
          text(entry.id, `${path}.entries.id`, true);
          markdownObjects.push({ value: entry, path: `${path}.entries.${String(entry.id)}` });
          text(entry.name, `${path}.entries.name`, true);
          text(entry.description, `${path}.entries.description`);
          if (entry.aliases !== undefined) strings(entry.aliases, `${path}.entries.aliases`);
        }
        if (item.source !== undefined) {
          const source = record(item.source, `${path}.source`);
          text(source.name, `${path}.source.name`, true);
          text(source.version, `${path}.source.version`, true);
          if (source.reference !== undefined) text(source.reference, `${path}.source.reference`, true);
        }
      }
    }
  }
  validateKnowledge(value as Knowledge);
  // Preserve structural/identity diagnostics before checking the callable contract.
  for (const { value, path } of markdownObjects) markdown(value, path);
}
