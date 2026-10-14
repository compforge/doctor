import type { PluginDefinition } from "@compforge/doctor-plugin";
import {
  knowledgeItems, knowledgeReference, ownerIdentity, selectKnowledgeOwners,
  type KnowledgeItem, type KnowledgeOwner, type KnowledgeSelection,
} from "./catalog";

interface SearchDocument {
  id: string;
  title: string;
  fields: readonly string[];
  childKind?: "step" | "section" | "entry";
}

function documents(item: KnowledgeItem): SearchDocument[] {
  if (item.kind === "concept") {
    const { id, name, description } = item.value;
    return [{ id, title: name, fields: [id, name, description] }];
  }
  const { id, title, summary } = item.value;
  const root: SearchDocument = { id, title, fields: [id, title, summary] };
  if (item.kind === "workflow") {
    return [root, ...item.value.steps.map(step => ({ id: step.id, title: step.title,
      fields: [step.id, step.title, step.description], childKind: "step" as const }))];
  }
  if (item.kind === "article") {
    return [root, ...item.value.sections.map(section => ({ id: section.id, title: section.title,
      fields: [section.id, section.title, section.body], childKind: "section" as const }))];
  }
  const source = item.value.source;
  if (source) root.fields = [...root.fields, source.name, source.version, ...(source.reference ? [source.reference] : [])];
  return [root, ...item.value.entries.map(entry => ({ id: entry.id, title: entry.name,
    fields: [entry.id, entry.name, entry.description, ...(entry.aliases ?? [])], childKind: "entry" as const }))];
}

/** Short context around the first matching keyword; the complete body stays addressable through show. */
function snippet(text: string, terms: readonly string[]): string {
  const folded = text.toLowerCase();
  const first = Math.min(...terms.map(term => folded.indexOf(term)));
  const start = Math.max(0, first - 60);
  const end = Math.min(text.length, start + 198);
  return `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function searchOwner(owner: KnowledgeOwner, terms: readonly string[]) {
  return knowledgeItems(owner.knowledge).flatMap(item => documents(item).flatMap(document => {
    const text = document.fields.join("\n").replace(/\s+/gu, " ").trim();
    const folded = text.toLowerCase();
    if (!terms.every(term => folded.includes(term))) return [];
    return [{ ...ownerIdentity(owner), ref: knowledgeReference(owner, item, document.childKind ? document.id : undefined),
      kind: item.kind, id: item.value.id, childKind: document.childKind,
      childId: document.childKind ? document.id : undefined, title: document.title, snippet: snippet(text, terms) }];
  }));
}

/**
 * @spec Search covers Product and all Services by default; an explicit Service selection includes only those Services.
 * @rule Search reads structured fields only. Parent summaries and child bodies are separate documents; Markdown methods never run.
 * @case id=knowledge_search_scope,desc=`Same term appears in Product and Services`,expect=`Default returns all; -s returns selected Services only`
 * @see {@link component://docs/commands/knowledge.md}
 */
export function searchKnowledge(plugin: PluginDefinition | undefined, query: string,
  selection: Pick<KnowledgeSelection, "services"> = {}) {
  const normalized = query.replace(/\s+/gu, " ").trim();
  if (!normalized) throw new Error("Knowledge search query must not be empty");
  const terms = normalized.toLowerCase().split(" ");
  const owners = selectKnowledgeOwners(plugin,
    selection.services === undefined ? { all: true } : { services: selection.services });
  return { query: normalized, matches: owners.flatMap(owner => searchOwner(owner, terms)) };
}
