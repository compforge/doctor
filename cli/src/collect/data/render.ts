import {
  htmlHeading,
  htmlList,
  htmlParagraph,
  htmlTable,
} from "../output/html";
import type { Fact, RelationFact } from "@compforge/doctor-plugin";
import type { CollectedDataInspectResult, DataDiagnosis } from "./model";

function value(value: string | undefined): string {
  return value || "未找到";
}

function collectedResults(diagnosis: DataDiagnosis): CollectedDataInspectResult[] {
  return diagnosis.evidence.facts.capabilityResults.filter(
    (result): result is CollectedDataInspectResult => result.status === "collected",
  );
}

function identifierNames(results: readonly CollectedDataInspectResult[]): string[] {
  return [...new Set(results.flatMap((item) => Object.keys(item.result.resolution.identifiers)))];
}

function resultRows(results: readonly CollectedDataInspectResult[], identifiers: readonly string[]): string[][] {
  return results.map((item) => [
    item.service,
    item.stage,
    item.result.resolution.resolvedAs,
    ...identifiers.map((name) => value(item.result.resolution.identifiers[name])),
  ]);
}

function factKey(fact: Fact): string {
  if (fact.factType === "record") return fact.recordKey;
  if (fact.factType === "relation") {
    const relation = fact as RelationFact;
    return `${relation.from.kind}:${relation.from.value} → ${relation.to.kind}:${relation.to.value}`;
  }
  return "—";
}

function capabilityFacts(results: readonly CollectedDataInspectResult[]): string {
  const resolved = results.filter((item) => item.result.resolution.resolvedAs !== "unresolved");
  if (!resolved.length) return htmlParagraph("没有 Service 将该业务 ID 解析为已知业务对象。");
  return htmlTable(
    ["service", "stage", "input ID", "resolved as", "type", "kind", "key", "data"],
    resolved.flatMap((item) => item.result.facts.map((fact) => [
      item.service,
      item.stage,
      item.result.resolution.inputId,
      item.result.resolution.resolvedAs,
      fact.factType,
      fact.kind,
      factKey(fact),
      JSON.stringify(fact, null, 2) ?? String(fact),
    ])),
    { search: { placeholder: "搜索业务数据关键字" } },
  );
}

export function buildDataSummary(diagnosis: DataDiagnosis): string {
  const results = collectedResults(diagnosis);
  const identifiers = identifierNames(results);
  const columns = ["service", "stage", "resolved as", ...identifiers];
  const rows = resultRows(results, identifiers);
  const coverage = diagnosis.coverage[0];
  return [
    "# 业务数据汇集诊断",
    "",
    `| ${columns.join(" | ")} |`,
    `|${columns.map(() => "---").join("|")}|`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
    "",
    "## Findings",
    "",
    ...(diagnosis.findings.length ? diagnosis.findings.map((item) => `- ${item.message}`) : ["- 未发现已内置的业务数据异常"]),
    "",
    "## Coverage",
    "",
    `- 状态：${coverage?.status ?? "insufficient"}`,
    ...((coverage?.missingEvidence ?? []).map((item) => `- 缺失：${item}`)),
    "",
    "完整业务记录与解析结果见 raw 目录。",
  ].join("\n");
}

export function buildDataHtml(diagnosis: DataDiagnosis): string {
  const results = collectedResults(diagnosis);
  const identifiers = identifierNames(results);
  const coverage = diagnosis.coverage[0];
  return [
    htmlHeading(1, "业务数据汇集诊断"),
    htmlTable(
      ["service", "stage", "resolved as", ...identifiers],
      resultRows(results, identifiers),
    ),
    htmlHeading(2, "业务数据"),
    capabilityFacts(results),
    htmlHeading(2, "Findings"),
    htmlList(diagnosis.findings.length
      ? diagnosis.findings.map((item) => item.message)
      : ["未发现已内置的业务数据异常"]),
    htmlHeading(2, "Coverage"),
    htmlList([
      `状态：${coverage?.status ?? "insufficient"}`,
      ...(coverage?.missingEvidence ?? []).map((item) => `缺失：${item}`),
    ]),
    htmlParagraph("完整解析过程仍保留在原始证据中。"),
  ].join("\n");
}
