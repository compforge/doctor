import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { PluginDefinition } from "@compforge/doctor-plugin";
import type { ResultRef } from "../command/manifest";
import type { SerializeContext } from "../command/serialization/context";
import { summaryText } from "../command/summary";
import { knowledgeItems, knowledgeReference, selectKnowledgeOwners, type KnowledgeOwner } from "../knowledge/catalog";
import type { CollectDelegateResult } from "./composite";
import { readServiceEvidence, type ServiceEvidence } from "./service-evidence";

function serviceDirectory(name: string): string {
  // Keep conventional names readable; other names have a portable, case-insensitive unique component.
  const segment = /^[a-z0-9][a-z0-9_-]{0,90}$/.test(name) ? name : "~" + createHash("sha256").update(name).digest("hex");
  return `services/${segment}`;
}

function writeKnowledge(context: SerializeContext, owner: KnowledgeOwner | undefined, path: string): boolean {
  if (!owner) return false;
  const items = knowledgeItems(owner.knowledge);
  if (!items.length) return false;
  try {
    const sections = items.map(item => `## ${knowledgeReference(owner, item)}\n\n${item.value.markdown()}`);
    context.writeText(path, [`# ${owner.namespace} · ${owner.plugin.id}@${owner.plugin.version}`, ...sections, ""].join("\n\n"));
    return true;
  } catch (error) {
    context.failure(new Error(`Knowledge ${owner.namespace}: ${String(error)}`));
    return false;
  }
}

/** Project direct Operation declarations; preserve intra-Service hops in the chain and only link existing evidence pages. */
function writeOperationCalls(context: SerializeContext, plugin: PluginDefinition, pages: ReadonlyMap<string, readonly ServiceEvidence[]>) {
  const catalog = plugin.services;
  const operations = catalog.operations();
  const sections = new Map<string, string[]>();
  if (!operations.length) return sections;
  const owners = new Map(operations.map(({ operation, service }) => [operation.id(), service.name]));
  const peers = new Map<string, Map<string, Set<string>>>();
  function addPeer(service: string, label: string, peer: string) {
    let groups = peers.get(service);
    if (!groups) {
      groups = new Map();
      peers.set(service, groups);
    }
    let names = groups.get(label);
    if (!names) {
      names = new Set();
      groups.set(label, names);
    }
    names.add(peer);
  }

  const file = "knowledge/operations.md";
  const lines = ["# Operation 调用关系", "",
    `${summaryText(plugin.id)}@${summaryText(plugin.version)} 声明的直接调用。calls 表示常规路径，mayCalls 表示条件路径。`, ""];
  for (const service of catalog.services) {
    if (!service.operations?.length) continue;
    const directory = serviceDirectory(service.name);
    const anchor = `service-${posix.basename(directory)}`;
    lines.push(`<a id="${anchor}"></a>`, `## ${summaryText(service.name)}`, "");
    sections.set(service.name, [`[Operation 调用声明](<../../${file}#${anchor}>)`]);
    for (const operation of service.operations) {
      lines.push(`- ${summaryText(operation.id())}`);
      for (const kind of ["calls", "mayCalls"] as const) {
        const targets = operation[kind];
        if (!targets?.length) continue;
        lines.push(`  - ${kind} → ${targets.map(target => summaryText(target)).join("、")}`);
        for (const target of targets) {
          const peer = owners.get(target)!; // ServiceCatalog validates Operation IDs and call targets.
          if (peer === service.name) continue;
          addPeer(service.name, `下游（${kind}）`, peer);
          addPeer(peer, `上游（${kind}）`, service.name);
        }
      }
    }
    lines.push("");
  }
  context.writeText(file, lines.join("\n"));
  for (const [name, groups] of peers) {
    for (const [label, names] of groups) {
      const links = [...names].map(peer => pages.has(peer)
        ? `[${summaryText(peer)}](<${posix.relative(serviceDirectory(name), serviceDirectory(peer))}/summary.md>)`
        : summaryText(peer));
      sections.get(name)!.push(`- ${label}：${links.join("、")}`);
    }
  }
  return sections;
}

/** Emit portable relative links after child serialization has assigned the final evidence paths. */
export function writeServiceNavigation(context: SerializeContext, steps: readonly CollectDelegateResult[], children: readonly ResultRef[]): string[] {
  const plugin = context.plugin;
  if (!plugin || !context.includeEvidenceNavigation) return [];
  const owners = selectKnowledgeOwners(plugin, { all: true });
  const byService = new Map<string, ServiceEvidence[]>();
  for (const [i, step] of steps.entries()) {
    const manifest = children[i]!.manifest;
    try {
      const rows = readServiceEvidence(context.directory, manifest, step.kind, step.bizId);
      // These two delegates explicitly select a Service scope before running their preparation.
      if (!rows.length && step.result.status === "failed" && (step.kind === "inspect" || step.kind === "data")) {
        const requested = step.kind === "inspect" ? plugin.services.services.map(s => s.name)
          : [...new Set(plugin.services.extensions("data.id").map(entry => entry.service.name))];
        for (const service of requested) rows.push({ service, scope: step.bizId, file: manifest, kind: step.kind,
          detail: `采集命令失败，缺少该服务结果 · ${step.result.reason}`, gap: true });
      }
      for (const row of rows) {
        const service = plugin.services.find(row.service);
        if (!service) continue;
        const list = byService.get(service.name) ?? [];
        list.push(row);
        byService.set(service.name, list);
      }
    } catch (error) { context.failure(new Error(`Service navigation (${step.kind}): ${String(error)}`)); }
  }
  if (!byService.size) return [];
  const productKnowledge = writeKnowledge(context, owners.find(owner => !owner.service), "knowledge/product.md");
  const index = ["## Service", "", ...(productKnowledge ? ["[产品知识](<knowledge/product.md>)", ""] : [])];
  const operations = writeOperationCalls(context, plugin, byService);
  if (operations.size) index.push("[Operation 调用声明](<knowledge/operations.md>)", "");
  for (const owner of owners) {
    if (!owner.service) continue;
    const rows = byService.get(owner.service);
    if (!rows) continue;
    const dir = serviceDirectory(owner.service);
    const name = summaryText(owner.service);
    const description = owner.description ? summaryText(owner.description) : "";
    const body = [`# ${name}`, "", description, ""];
    if (writeKnowledge(context, owner, `${dir}/knowledge.md`)) body.push("[Service 知识](<knowledge.md>)", "");
    if (productKnowledge) body.push("[产品知识](<../../knowledge/product.md>)", "");
    const calls = operations.get(owner.service);
    if (calls) body.push(...calls, "");
    const kinds = [...new Set(rows.map(row => row.kind))];
    for (const kind of kinds) {
      body.push(`## ${kind}`, "");
      for (const row of rows.filter(row => row.kind === kind)) {
        body.push(`- ${row.gap ? "采集缺口 · " : ""}${row.scope ? summaryText(row.scope) + " · " : ""}${summaryText(row.detail)} · [原文](<${posix.relative(dir, row.file)}>)`);
      }
      body.push("");
    }
    context.writeText(`${dir}/summary.md`, body.join("\n"));
    const gaps = [...new Set(rows.filter(row => row.gap).map(row => row.kind))];
    index.push(`- [${name}](<${dir}/summary.md>) · ${[description, kinds.join(" / "), gaps.length ? "采集缺口：" + gaps.join(" / ") : ""].filter(Boolean).join(" · ")}`);
  }
  return [...index, ""];
}
