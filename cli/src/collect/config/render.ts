import {
  htmlHeading,
  htmlList,
  htmlParagraph,
  htmlTable,
  type HtmlReportSection,
} from "../output/html";
import type { ConfigComparisonRow, ConfigDiagnosis, JsonValue } from "./model";

function displayValue(value: JsonValue | undefined): string {
  if (value === undefined) return "—";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function displayTenantConfig(row: ConfigComparisonRow): string {
  return row.tenantConfig
    ? `${displayValue(row.tenantConfig.value)}\nscope: ${row.tenantConfig.scope}`
    : "—";
}

function markdownCell(value: unknown): string {
  return String(value ?? "—")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "\\|")
    .replaceAll(/\r?\n/g, "<br>");
}

function markdownTable(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  if (!rows.length) return ["_无配置项_"];
  return [
    `| ${headers.map(markdownCell).join(" | ")} |`,
    `|${headers.map(() => "---").join("|")}|`,
    ...rows.map((row) => `| ${row.map(markdownCell).join(" | ")} |`),
  ];
}

function tableRows(diagnosis: ConfigDiagnosis): string[][] {
  return diagnosis.evidence.rows.map((row) => [
    row.name,
    displayValue(row.env),
    displayTenantConfig(row),
  ]);
}

function tenantLabel(diagnosis: ConfigDiagnosis): string {
  return diagnosis.evidence.facts.tenantRequest.status === "collected"
    ? `${diagnosis.evidence.facts.tenantRequest.tenantName ?? "未命名"}（${diagnosis.evidence.facts.tenantRequest.tenantId}）`
    : "未选择（仅 Env 配置）";
}

export function buildConfigSummary(diagnosis: ConfigDiagnosis): string {
  const services = diagnosis.evidence.facts.serviceTargets.status === "collected"
    ? Object.keys(diagnosis.evidence.facts.serviceTargets.services).length
    : 0;
  return [
    "# Service 配置统计",
    "",
    `- Service：${services}`,
    `- 配置项：${diagnosis.evidence.rows.length}`,
    `- 租户：${tenantLabel(diagnosis)}`,
    "- Env 来源仅包含 ConfigMap 与 Deployment env；Tenant config 由 Plugin 的配置读取能力提供。",
    "",
    "## Coverage",
    "",
    ...diagnosis.coverage.flatMap((item) => [
      `- ${item.goal}：${item.status}`,
      ...item.missingEvidence.map((missing) => `  - 缺失：${missing}`),
    ]),
    "",
    "## 配置对照",
    "",
    ...markdownTable(["name", "Env（ConfigMap + Deployment env）", "Tenant config"], tableRows(diagnosis)),
  ].join("\n");
}

export function buildConfigHtml(diagnosis: ConfigDiagnosis): string {
  const services = diagnosis.evidence.facts.serviceTargets.status === "collected"
    ? Object.keys(diagnosis.evidence.facts.serviceTargets.services).length
    : 0;
  return [
    htmlHeading(1, "Service 配置统计"),
    htmlList([
      `Service：${services}`,
      `配置项：${diagnosis.evidence.rows.length}`,
      `租户：${tenantLabel(diagnosis)}`,
    ]),
    htmlParagraph("同名配置合并为一行。Env 列来自 ConfigMap 与 Deployment env；Tenant config 列由 Plugin 提供，并在单元格内标明 scope。"),
    htmlParagraph("显式 Deployment env 按 Kubernetes 语义覆盖同名 ConfigMap 值。"),
    htmlHeading(2, "Coverage"),
    htmlList(diagnosis.coverage.flatMap((item) => [
      `${item.goal}：${item.status}`,
      ...item.missingEvidence.map((missing) => `缺失：${missing}`),
    ])),
  ].join("\n");
}

export function buildConfigHtmlSections(diagnosis: ConfigDiagnosis): HtmlReportSection[] {
  return [{
    title: "配置对照",
    html: htmlTable(
      ["name", "Env（ConfigMap + Deployment env）", "Tenant config"],
      tableRows(diagnosis),
      { search: { column: 0, placeholder: "按配置名检索" } },
    ),
  }];
}
