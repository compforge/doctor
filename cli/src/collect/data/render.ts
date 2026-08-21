import {
  escapeHtml,
  htmlHeading,
  htmlList,
  htmlParagraph,
  htmlTable,
} from "../output/html";
import type { CollectedDataInspectFact, DataDiagnosis } from "./model";

function value(value: string | undefined): string {
  return value || "未找到";
}

function collectedFacts(diagnosis: DataDiagnosis): CollectedDataInspectFact[] {
  return diagnosis.evidence.facts.capabilityFacts.filter(
    (fact): fact is CollectedDataInspectFact => fact.status === "collected",
  );
}

function identifierNames(facts: readonly CollectedDataInspectFact[]): string[] {
  return [...new Set(facts.flatMap((item) => Object.keys(item.summary.identifiers)))];
}

function factRows(facts: readonly CollectedDataInspectFact[], identifiers: readonly string[]): string[][] {
  return facts.map((item) => [
    item.service,
    item.stage,
    item.summary.resolvedAs,
    ...identifiers.map((name) => value(item.summary.identifiers[name])),
  ]);
}

function capabilityResults(facts: readonly CollectedDataInspectFact[]): string {
  const resolved = facts.filter((item) => item.summary.resolvedAs !== "unresolved");
  if (!resolved.length) return htmlParagraph("没有 Service 将该业务 ID 解析为已知业务对象。");
  return resolved.map((item) => {
    const title = `${item.service} · ${item.stage} · ${item.fact.resolution.inputId} · ${item.summary.resolvedAs}`;
    const fact = JSON.stringify(item.fact, null, 2) ?? String(item.fact);
    return `<details class="data-result" open><summary><span>${escapeHtml(title)}</span></summary><pre><code>${escapeHtml(fact)}</code></pre></details>`;
  }).join("");
}

export function buildDataSummary(diagnosis: DataDiagnosis): string {
  const facts = collectedFacts(diagnosis);
  const identifiers = identifierNames(facts);
  const columns = ["service", "stage", "resolved as", ...identifiers];
  const rows = factRows(facts, identifiers);
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
  const facts = collectedFacts(diagnosis);
  const identifiers = identifierNames(facts);
  const coverage = diagnosis.coverage[0];
  return [
    htmlHeading(1, "业务数据汇集诊断"),
    htmlTable(
      ["service", "stage", "resolved as", ...identifiers],
      factRows(facts, identifiers),
    ),
    htmlHeading(2, "业务数据"),
    capabilityResults(facts),
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
