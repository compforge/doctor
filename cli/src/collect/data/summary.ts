import { projectSummary } from "../../command/summary";
import type { Fact } from "@compforge/doctor-plugin";
import { aggregateCommandStatus } from "../../command/result";
import { CommandStatus } from "../../command/status";
import { summaryText } from "../../command/summary";
import type { DataFacts, DataOutput } from "./model";

type Item = DataOutput["items"][number];
interface RecordSummary { group: string; title: string; fields: string[]; references: string[] }
interface ItemSummary { id: string; status: string; identifiers: string[]; records: RecordSummary[]; findings: string[]; missing: string[] }

function displayedFields(fact: Exclude<Fact, { factType: "relation" }>): string[] {
  const value = fact.factType === "record" ? fact.record : fact.value;
  return fact.summary ? projectSummary(fact.summary, value).fields.map(field =>
    `${summaryText(field.label)}=${summaryText(field.value)}`) : [];
}

/** Pure projection: business labels/paths belong to the producer; Core never guesses status fields. */
export function projectDataSummary(items: readonly Item[], source?: DataFacts): ItemSummary[] {
  return items.map(item => {
    const facts = source ?? item.diagnosis?.evidence.facts;
    const positions = new Map(facts?.capabilityResults.map((query, index) => [query.id, index]) ?? []);
    const identifiers = new Set<string>();
    const records = new Map<string, RecordSummary>();
    for (const query of item.diagnosis?.evidence.facts.capabilityResults ?? []) {
      if (query.status !== "collected") continue;
      for (const [kind, value] of Object.entries(query.result.resolution.identifiers)) {
        if (value) identifiers.add(`${kind}: ${value}`);
      }
      query.result.facts.forEach((fact, index) => {
        if (fact.factType === "relation") { identifiers.add(`${fact.to.kind}: ${fact.to.value}`); return; }
        const id = fact.factType === "record" ? fact.recordKey : fact.kind;
        // Keep conflicting snapshots visible rather than merging their field values.
        const key = JSON.stringify([query.service, fact.kind, fact.schemaVersion, id,
          fact.factType === "record" ? fact.record : fact.value]);
        const entry = records.get(key) ?? { group: JSON.stringify([query.service, fact.kind, fact.summary?.title]), title: `${query.service} / ${fact.summary?.title ?? fact.kind} / ${id}`,
          fields: displayedFields(fact), references: [] };
        entry.references.push(`capabilityResults.${positions.get(query.id)}.result.facts.${index}`);
        records.set(key, entry);
      });
    }
    return { id: item.bizId, status: item.status, identifiers: [...identifiers], records: [...records.values()],
      findings: [...new Set(item.diagnosis?.findings.map(finding => finding.message) ?? [])],
      missing: [...new Set([...(item.reason ? [item.reason] : []),
        ...(item.diagnosis?.coverage.flatMap(coverage => coverage.missingEvidence) ?? []),
        ...(!item.diagnosis ? ["未形成业务诊断"] : []),
        ...(item.diagnosis?.coverage.some(coverage => coverage.status !== "sufficient") ? ["业务数据关联证据不完整"] : [])])] };
  });
}

/** Round-robin declared record groups so verbose timelines cannot hide another Service's runtime state. */
function selectRecords(records: readonly RecordSummary[], limit: number): RecordSummary[] {
  const groups = new Map<string, RecordSummary[]>();
  for (const record of records) {
    const group = groups.get(record.group) ?? [];
    group.push(record);
    groups.set(record.group, group);
  }
  const selected: RecordSummary[] = [];
  for (let index = 0; selected.length < Math.min(limit, records.length); index++) {
    for (const group of groups.values()) {
      if (group[index]) selected.push(group[index]!);
      if (selected.length === limit) break;
    }
  }
  return selected;
}

/** Markdown and terminal summaries share one bounded projection and evidence addresses. */
export function buildDataEvidenceSummary(items: readonly Item[], source?: DataFacts, markdown = true): string {
  const projected = projectDataSummary(items, source);
  const status = aggregateCommandStatus(items.map((item, index) =>
    item.status === CommandStatus.Ok && projected[index]!.missing.length ? CommandStatus.Partial : item.status));
  const lines = [markdown ? "# 业务数据摘要" : "业务数据摘要", "", `业务 ID：${items.length}`,
    `采集状态：${items.length ? status : "unknown"}`,
    "业务状态：按下列 Service 记录判读；采集成功不代表业务成功。", ""];
  for (const item of projected.slice(0, 16)) {
    lines.push(`## ${summaryText(item.id)}（${item.status}）`, "", "### 关联 ID", "",
      ...item.identifiers.slice(0, 40).map(id => `- ${summaryText(id)}`));
    if (item.identifiers.length > 40) lines.push(`- 另有 ${item.identifiers.length - 40} 个 ID，见原始 Facts。`);
    lines.push("", "### 诊断发现", "",
      ...(item.findings.length ? item.findings.slice(0, 20).map(text => `- ${summaryText(text)}`) : ["- 未发现已内置异常"]),
      "", "### 采集缺口", "", ...(item.missing.length ? item.missing.slice(0, 20).map(text => `- ${summaryText(text)}`) : ["- 无"]), "");
    if (item.findings.length > 20 || item.missing.length > 20) lines.push("更多发现或缺口见 diagnosis.json。", "");
    lines.push("", "### 业务记录", "");
    for (const record of selectRecords(item.records, 20)) {
      lines.push(`- ${summaryText(record.title)}`, ...record.fields.map(field => `  - ${field}`),
        `  - [原始证据](raw/facts.json)：${record.references.slice(0, 3).map(path => `\`${path}\``).join("、")}`);
      if (record.references.length > 3) lines.push(`  - 另有 ${record.references.length - 3} 个来源，见原始 Facts。`);
    }
    if (item.records.length > 20) lines.push(`- 另有 ${item.records.length - 20} 条记录，见原始 Facts。`);

  }
  if (projected.length > 16) lines.push(`另有 ${projected.length - 16} 个输入，见 diagnosis.json。`);
  lines.push("[诊断与完整缺口](diagnosis.json) · [完整 Facts](raw/facts.json) · [清单](manifest.json)", "");
  return lines.join("\n");
}
