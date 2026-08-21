import {
  htmlHeading,
  htmlList,
  htmlParagraph,
  type HtmlReportSection,
} from "../output/html";
import { TENANT_FACETS } from "./facets";
import type { TenantDiagnosis } from "./model";

function facetViews(diagnosis: TenantDiagnosis) {
  return TENANT_FACETS.map((facet) => facet.render(diagnosis.evidence.facts));
}

export function buildTenantSummary(diagnosis: TenantDiagnosis): string {
  const tenant = diagnosis.evidence.facts.tenant;
  const views = facetViews(diagnosis);
  return [
    "# Tenant Inspect",
    "",
    tenant.status === "collected"
      ? `- 租户：${tenant.displayName || tenant.name}（${tenant.id}）`
      : `- 租户：未取得（${tenant.reason}）`,
    ...views.flatMap((view) => view.summary.map((line) => `- ${line}`)),
    "",
    "## Coverage",
    "",
    ...diagnosis.coverage.flatMap((item) => [
      `- ${item.goal}：${item.status}`,
      ...item.missingEvidence.map((missing) => `  - 缺失：${missing}`),
    ]),
    "",
    ...views.flatMap((view) => view.markdown),
  ].join("\n");
}

export function buildTenantHtml(diagnosis: TenantDiagnosis): string {
  const tenant = diagnosis.evidence.facts.tenant;
  const views = facetViews(diagnosis);
  return [
    htmlHeading(1, "Tenant Inspect"),
    htmlList([
      tenant.status === "collected"
        ? `租户：${tenant.displayName || tenant.name}（${tenant.id}）`
        : `租户：未取得（${tenant.reason}）`,
      ...views.flatMap((view) => view.summary),
    ]),
    htmlParagraph("租户各领域数据均为只读 Inspect Facts；本命令不执行 validation、inference 或其它主动业务调用。"),
    htmlHeading(2, "Coverage"),
    htmlList(diagnosis.coverage.flatMap((item) => [
      `${item.goal}：${item.status}`,
      ...item.missingEvidence.map((missing) => `缺失：${missing}`),
    ])),
  ].join("\n");
}

export function buildTenantHtmlSections(diagnosis: TenantDiagnosis): HtmlReportSection[] {
  return facetViews(diagnosis).flatMap((view) => view.sections);
}
