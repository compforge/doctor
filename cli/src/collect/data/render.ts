import { htmlHeading, htmlList, htmlParagraph, htmlTable } from "../output/html";
import type { DataDiagnosis, DataObservation } from "./model";

function value(value: string | undefined): string {
  return value || "未找到";
}

function identifierNames(observations: readonly DataObservation[]): string[] {
  return [...new Set(observations.flatMap((item) => Object.keys(item.summary.identifiers)))];
}

function observationRows(observations: readonly DataObservation[], identifiers: readonly string[]): string[][] {
  return observations.map((item) => [
    item.service,
    item.stage,
    item.summary.resolvedAs,
    ...identifiers.map((name) => value(item.summary.identifiers[name])),
  ]);
}

export function buildDataSummary(diagnosis: DataDiagnosis): string {
  const identifiers = identifierNames(diagnosis.evidence.observations);
  const columns = ["service", "stage", "resolved as", ...identifiers];
  const rows = observationRows(diagnosis.evidence.observations, identifiers);
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
  const identifiers = identifierNames(diagnosis.evidence.observations);
  const coverage = diagnosis.coverage[0];
  return [
    htmlHeading(1, "业务数据汇集诊断"),
    htmlTable(
      ["service", "stage", "resolved as", ...identifiers],
      observationRows(diagnosis.evidence.observations, identifiers),
    ),
    htmlHeading(2, "Findings"),
    htmlList(diagnosis.findings.length
      ? diagnosis.findings.map((item) => item.message)
      : ["未发现已内置的业务数据异常"]),
    htmlHeading(2, "Coverage"),
    htmlList([
      `状态：${coverage?.status ?? "insufficient"}`,
      ...(coverage?.missingEvidence ?? []).map((item) => `缺失：${item}`),
    ]),
    htmlParagraph("完整业务记录与解析结果见原始证据。"),
  ].join("\n");
}
