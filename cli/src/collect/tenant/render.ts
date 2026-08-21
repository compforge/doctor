import {
  htmlHeading,
  htmlList,
  htmlParagraph,
  htmlTable,
  type HtmlReportSection,
} from "../output/html";
import type {
  CollectedTenantContributionFact,
  TenantDiagnosis,
} from "./model";

function display(value: string | number | boolean | null): string {
  return value === null ? "—" : String(value);
}

function markdownCell(value: string | number | boolean | null): string {
  return display(value).replaceAll("|", "\\|").replaceAll("\n", "<br>");
}

function collectedContributions(diagnosis: TenantDiagnosis): CollectedTenantContributionFact[] {
  return Object.values(diagnosis.evidence.facts.contributions).flatMap((fact) => (
    fact.status === "collected" ? [fact as CollectedTenantContributionFact] : []
  ));
}

function contributionSummary(diagnosis: TenantDiagnosis): string[] {
  return Object.entries(diagnosis.evidence.facts.contributions).flatMap(([id, fact]) => {
    if (fact.status !== "collected") return [`${fact.title || id}：未取得（${fact.reason}）`];
    return (fact.summary ?? []).map((item) => `${item.label}：${display(item.value)}`);
  });
}

export function buildTenantSummary(diagnosis: TenantDiagnosis): string {
  const tenant = diagnosis.evidence.facts.tenant;
  const contributions = collectedContributions(diagnosis);
  return [
    "# Tenant Inspect",
    "",
    tenant.status === "collected"
      ? `- 租户：${tenant.displayName || tenant.name}（${tenant.id}）`
      : `- 租户：未取得（${tenant.reason}）`,
    ...contributionSummary(diagnosis).map((line) => `- ${line}`),
    "",
    "## Coverage",
    "",
    ...diagnosis.coverage.flatMap((item) => [
      `- ${item.goal}：${item.status}`,
      ...item.missingEvidence.map((missing) => `  - 缺失：${missing}`),
    ]),
    "",
    ...contributions.flatMap((contribution) => [
      `## ${contribution.title}`,
      "",
      ...(contribution.tables ?? []).flatMap((table) => [
        `### ${table.title}`,
        "",
        `| ${table.columns.map(markdownCell).join(" | ")} |`,
        `|${table.columns.map(() => "---").join("|")}|`,
        ...table.rows.map((row) => `| ${row.map(markdownCell).join(" | ")} |`),
        "",
      ]),
    ]),
  ].join("\n");
}

export function buildTenantHtml(diagnosis: TenantDiagnosis): string {
  const tenant = diagnosis.evidence.facts.tenant;
  return [
    htmlHeading(1, "Tenant Inspect"),
    htmlList([
      tenant.status === "collected"
        ? `租户：${tenant.displayName || tenant.name}（${tenant.id}）`
        : `租户：未取得（${tenant.reason}）`,
      ...contributionSummary(diagnosis),
    ]),
    htmlParagraph("租户贡献均为只读 Inspect Facts；业务查询与安全投影由当前 Plugin 负责。"),
    htmlHeading(2, "Coverage"),
    htmlList(diagnosis.coverage.flatMap((item) => [
      `${item.goal}：${item.status}`,
      ...item.missingEvidence.map((missing) => `缺失：${missing}`),
    ])),
  ].join("\n");
}

export function buildTenantHtmlSections(diagnosis: TenantDiagnosis): HtmlReportSection[] {
  return collectedContributions(diagnosis).flatMap((contribution) => (
    (contribution.tables ?? []).map((table) => ({
      title: `${contribution.title} / ${table.title}`,
      html: htmlTable(table.columns, table.rows, { search: table.search }),
    }))
  ));
}
