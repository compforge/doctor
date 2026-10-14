import type { Entry, KnowledgeSource, Workflow } from "@compforge/doctor-plugin";
import {
  resolveKnowledgeItem, knowledgeReference, ownerIdentity, knowledgeIndex,
  type KnowledgeSelection, type KnowledgeOwner,
} from "./catalog";
import type { PluginDefinition } from "@compforge/doctor-plugin";

export function readKnowledge(plugin: PluginDefinition | undefined, ref: string, selection: KnowledgeSelection = {}, renderMarkdown = true) {
  const { owner, item, reference } = resolveKnowledgeItem(plugin, ref, selection);
  const identity = { ...ownerIdentity(owner), ref: knowledgeReference(owner, item, reference.childId), kind: item.kind,
    source: item.kind === "dictionary" ? item.value.source : undefined };
  if (reference.childId === undefined) return { ...identity, item: item.value, text: renderMarkdown ? item.value.markdown() : "" };
  if (item.kind === "concept") throw new Error("Concept references have no child ID");
  if (item.kind === "workflow") {
    const step = item.value.steps.find(step => step.id === reference.childId);
    if (!step) throw new Error(`Unknown Step '${reference.childId}'`);
    return { ...identity, childKind: "step", item: step, text: renderMarkdown ? step.markdown() : "" };
  }
  if (item.kind === "article") {
    const section = item.value.sections.find(section => section.id === reference.childId);
    if (!section) throw new Error(`Unknown Section '${reference.childId}'`);
    return { ...identity, childKind: "section", item: section, text: renderMarkdown ? section.markdown() : "" };
  }
  const entry = item.value.entries.find(entry => entry.id === reference.childId);
  if (!entry) throw new Error(`Unknown Entry '${reference.childId}'`);
  return { ...identity, childKind: "entry", item: entry, text: renderMarkdown ? entry.markdown() : "" };
}

export function lookupKnowledge(plugin: PluginDefinition | undefined, dictionary: string, query: string | undefined,
  selection: KnowledgeSelection = {}, renderMarkdown = true) {
  const value = dictionary.startsWith("dictionary/") || dictionary.startsWith("plugin/") ? dictionary : `dictionary/${encodeURIComponent(dictionary)}`;
  const { owner, item, reference } = resolveKnowledgeItem(plugin, value, selection);
  if (item.kind !== "dictionary" || reference.childId !== undefined) throw new Error("lookup requires a Dictionary reference without a child ID");
  const term = query?.trim();
  if (term === "") throw new Error("Dictionary query must not be empty");
  const entries = item.value.entries.filter(entry => term === undefined || entry.id === term
    || [entry.name, ...(entry.aliases ?? [])].some(name => name.toLowerCase().includes(term.toLowerCase())));
  const result = { ...ownerIdentity(owner), dictionary: item.value.id, ref: knowledgeReference(owner, item), query: term,
    source: item.value.source, total: item.value.entries.length,
    entries: entries.map(entry => ({ ref: knowledgeReference(owner, item, entry.id), entry })) };
  return { ...result, text: renderMarkdown ? lookupToMarkdown(result) : "" };
}

function lookupToMarkdown(result: {
  namespace: string; dictionary: string; source?: KnowledgeSource;
  total: number; query?: string; entries: { ref: string; entry: Entry }[];
}): string {
  const source = result.source;
  return [`${result.namespace} · ${result.dictionary}`, source ? `Source: ${source.name}@${source.version}` : undefined,
    source?.reference, `${result.entries.length}/${result.total} entries`,
    ...result.entries.map(({ ref, entry }) => `${ref}\n\n${entry.markdown()}`),
    result.query && !result.entries.length ? `No entry matches '${result.query}' in this dictionary.` : undefined,
  ].filter(value => value !== undefined).join("\n\n");
}

/** Overview expands the system model and keeps large articles/dictionaries as addressable indexes. */
export function overviewKnowledge(owner: KnowledgeOwner) {
  const index = knowledgeIndex(owner);
  return { ...ownerIdentity(owner), concepts: owner.knowledge.concepts ?? [], workflows: owner.knowledge.workflows ?? [],
    articles: index.items.filter(item => item.kind === "article"), dictionaries: index.items.filter(item => item.kind === "dictionary") };
}

/**
 * @spec Overview uses structured fields for compact text; show and lookup retain object Markdown.
 * @see {@link cli/docs/commands/knowledge.md}
 */
export function overviewToText(owner: KnowledgeOwner): string {
  const { concepts = [], workflows = [] } = owner.knowledge;
  const index = knowledgeIndex(owner);
  const header = [owner.namespace, owner.description,
    owner.upstream === undefined ? undefined : `Upstream: ${owner.upstream.join(", ") || "none"}`,
  ].filter(value => value !== undefined).join("\n");
  const sections: string[] = [];
  if (concepts.length) sections.push(["Concept",
    ...concepts.map(concept => `• ${concept.name}：${concept.description.replace(/\n/g, "\n  ")}`),
  ].join("\n"));
  if (workflows.length) sections.push(`Workflow\n${workflows.map(workflowOverview).join("\n\n")}`);
  for (const [kind, title] of [["article", "Article"], ["dictionary", "Dictionary"]] as const) {
    const items = index.items.filter(item => item.kind === kind);
    if (items.length) sections.push([title,
      ...items.map(item => `• ${kind}/${encodeURIComponent(item.id)} — ${item.title}`),
    ].join("\n"));
  }
  return [header, ...(sections.length ? sections : ["No knowledge declared."])].join("\n\n");
}

function workflowOverview(workflow: Workflow): string {
  const renderSteps = (parentId: string | undefined, indent: string): string[] => workflow.steps
    .filter(step => step.parentId === parentId)
    .flatMap((step, index) => [
      `${indent}${index + 1}. ${step.title}：${step.description.replace(/\n/g, `\n${indent}   `)}`,
      ...renderSteps(step.id, `${indent}  `),
    ]);
  return [`${workflow.title}（${workflow.id}）`, workflow.summary, ...renderSteps(undefined, "")].join("\n");
}
