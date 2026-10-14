import {
  createServiceCatalog, validateKnowledgeDeclaration,
  type Knowledge, type Concept, type Workflow, type Article, type Dictionary,
  type PluginDefinition,
} from "@compforge/doctor-plugin";

export type KnowledgeKind = "concept" | "workflow" | "article" | "dictionary";
export const KNOWLEDGE_KINDS: readonly KnowledgeKind[] = ["concept", "workflow", "article", "dictionary"];
export type KnowledgeItem = { kind: "concept"; value: Concept }
  | { kind: "workflow"; value: Workflow } | { kind: "article"; value: Article }
  | { kind: "dictionary"; value: Dictionary };
export interface KnowledgeSelection { services?: readonly string[]; all?: boolean; namespace?: string }
export interface KnowledgeOwner {
  namespace: string;
  plugin: { id: string; version: string };
  service?: string;
  description?: string;
  upstream?: readonly string[];
  knowledge: Knowledge;
}

/** @spec Product and Service scopes are disjoint; Knowledge is read directly without invoking extensions.
 * @see {@link cli/docs/commands/knowledge.md}
 */
export function selectKnowledgeOwners(plugin: PluginDefinition | undefined,
  selection: KnowledgeSelection = {}): KnowledgeOwner[] {
  if (selection.all && selection.services !== undefined) throw new Error("--all 不能与 --service 同时使用");
  if (!plugin) {
    if (selection.services !== undefined || selection.namespace !== undefined) throw new Error("No active Plugin for the selected knowledge owner");
    return [];
  }
  const catalog = createServiceCatalog(plugin.services.services);
  const productNamespace = `plugin/${plugin.id}`;
  const descriptors = [
    { namespace: productNamespace, service: undefined, description: plugin.description, knowledge: plugin.knowledge, upstream: undefined },
    ...catalog.services.map(service => ({ namespace: `${productNamespace}/service/${service.name}`, service: service.name,
      description: service.description, knowledge: service.knowledge, upstream: service.upstream })),
  ];
  const names = selection.services === undefined ? undefined : catalog.resolveNames(selection.services);
  if (names?.length === 0) throw new Error("--service 不能为空");
  let selected = descriptors.filter(owner => names !== undefined ? names.includes(owner.service ?? "")
    : selection.all || selection.namespace !== undefined || owner.service === undefined);
  if (selection.namespace !== undefined) {
    selected = selected.filter(owner => owner.namespace === selection.namespace);
    if (!selected.length) throw new Error(`Unknown or out-of-scope knowledge owner '${selection.namespace}'`);
  }
  return selected.map(descriptor => {
    if (descriptor.knowledge !== undefined) validateKnowledgeDeclaration(descriptor.knowledge, `${descriptor.namespace}.knowledge`);
    const knowledge = descriptor.knowledge ?? { markdown: () => "" };
    return { ...descriptor, plugin: { id: plugin.id, version: plugin.version }, knowledge };
  });
}

export function knowledgeItems(knowledge: Knowledge): KnowledgeItem[] {
  return [
    ...(knowledge.concepts ?? []).map(value => ({ kind: "concept" as const, value })),
    ...(knowledge.workflows ?? []).map(value => ({ kind: "workflow" as const, value })),
    ...(knowledge.articles ?? []).map(value => ({ kind: "article" as const, value })),
    ...(knowledge.dictionaries ?? []).map(value => ({ kind: "dictionary" as const, value })),
  ];
}

export function ownerIdentity(owner: KnowledgeOwner) {
  return { namespace: owner.namespace, plugin: owner.plugin, service: owner.service,
    description: owner.description, upstream: owner.upstream };
}

export function knowledgeReference(owner: KnowledgeOwner, item: KnowledgeItem, childId?: string): string {
  return `${owner.namespace}/${item.kind}/${encodeURIComponent(item.value.id)}${childId === undefined ? "" : `#${encodeURIComponent(childId)}`}`;
}

export function knowledgeIndex(owner: KnowledgeOwner, kind?: KnowledgeKind) {
  return { ...ownerIdentity(owner), items: knowledgeItems(owner.knowledge)
    .filter(item => kind === undefined || item.kind === kind).map(item => ({
      ref: knowledgeReference(owner, item), kind: item.kind, id: item.value.id,
      title: item.kind === "concept" ? item.value.name : item.value.title,
      summary: item.kind === "concept" ? item.value.description : item.value.summary,
    })) };
}

export interface KnowledgeReference { namespace?: string; kind: KnowledgeKind; id: string; childId?: string }

export function parseKnowledgeReference(value: string): KnowledgeReference {
  const match = /^(?:(plugin\/.+)\/)?(concept|workflow|article|dictionary)\/([^#]+)(?:#(.+))?$/.exec(value);
  if (!match) throw new Error(`Invalid knowledge reference '${value}'; use <kind>/<id>[#<child-id>]`);
  try {
    return { namespace: match[1], kind: match[2] as KnowledgeKind, id: decodeURIComponent(match[3]!),
      childId: match[4] === undefined ? undefined : decodeURIComponent(match[4]) };
  } catch { throw new Error(`Invalid encoding in knowledge reference '${value}'`); }
}

export function resolveKnowledgeItem(plugin: PluginDefinition | undefined, value: string,
  selection: KnowledgeSelection = {}) {
  const reference = parseKnowledgeReference(value);
  const owners = selectKnowledgeOwners(plugin, { ...selection, namespace: reference.namespace });
  const matches = owners.flatMap(owner => knowledgeItems(owner.knowledge)
    .filter(item => item.kind === reference.kind && item.value.id === reference.id).map(item => ({ owner, item })));
  if (!matches.length) throw new Error(`Unknown knowledge reference '${value}'`);
  if (matches.length > 1) throw new Error(`Ambiguous knowledge reference '${value}'; use ${matches.map(match => knowledgeReference(match.owner, match.item)).join(", ")}`);
  return { ...matches[0]!, reference };
}
