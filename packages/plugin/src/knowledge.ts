import { validateKnowledge, type Knowledge } from "@compforge/harness-common";

export {
  validateKnowledge, validateWorkflow, knowledgeToMarkdown, conceptToMarkdown,
  workflowToMarkdown, stepToMarkdown, articleToMarkdown, sectionToMarkdown,
  dictionaryToMarkdown, entryToMarkdown,
} from "@compforge/harness-common";
export type {
  Knowledge, Concept, Workflow, Step, Article, Section, Dictionary, Entry,
  KnowledgeSource, KnowledgeMarkdownOptions,
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

/** Validate plain Knowledge across installed ESM and injected Plugin boundaries without invoking handlers. */
export function validateKnowledgeDeclaration(value: unknown, label = "knowledge"): asserts value is Knowledge {
  const knowledge = record(value, label);
  for (const kind of ["concepts", "workflows", "articles", "dictionaries"] as const) {
    if (knowledge[kind] === undefined) continue;
    for (const item of records(knowledge[kind], `${label}.${kind}`)) {
      text(item.id, `${label}.${kind}.id`, true);
      const path = `${label}.${kind}.${String(item.id)}`;
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
          text(step.title, `${path}.steps.title`, true);
          text(step.description, `${path}.steps.description`);
          if (step.parentId !== undefined) text(step.parentId, `${path}.steps.parentId`, true);
        }
      } else if (kind === "articles") {
        for (const section of records(item.sections, `${path}.sections`)) {
          text(section.id, `${path}.sections.id`, true);
          text(section.title, `${path}.sections.title`, true);
          text(section.body, `${path}.sections.body`);
        }
      } else {
        for (const entry of records(item.entries, `${path}.entries`)) {
          text(entry.id, `${path}.entries.id`, true);
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
}
