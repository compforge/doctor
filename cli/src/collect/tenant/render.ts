import {
  htmlFactTable,
  htmlHeading,
  htmlList,
  htmlParagraph,
  type HtmlReportSection,
} from "../output/html";
import type {
  CollectedTenantCapabilityFact,
  TenantDiagnosis,
} from "./model";

function collectedCapabilities(diagnosis: TenantDiagnosis): CollectedTenantCapabilityFact[] {
  return diagnosis.evidence.facts.capabilityFacts.filter(
    (fact): fact is CollectedTenantCapabilityFact => fact.status === "collected",
  );
}

function capabilityLabel(fact: CollectedTenantCapabilityFact): string {
  return `${fact.service} · ${fact.capability}`;
}

function capabilitySummary(diagnosis: TenantDiagnosis): string[] {
  return diagnosis.evidence.facts.capabilityFacts.map((fact) => {
    if (fact.status !== "collected") return `${fact.service} · ${fact.capability}：未取得（${fact.reason}）`;
    return `${capabilityLabel(fact)}：${fact.result.facts.length} 条 Fact`;
  });
}

/** One reading entry for terminal and Markdown; raw capability Facts stay in the evidence bundle. */
export function buildTenantSummary(diagnosis: TenantDiagnosis): string {
  const tenant = diagnosis.evidence.facts.tenant;
  const capabilities = diagnosis.evidence.facts.capabilityFacts;
  const missing = diagnosis.coverage.flatMap((item) => item.missingEvidence.map((reason) => `${item.goal}：${reason}`));
  const status = tenant.status !== "collected" || diagnosis.coverage.some((item) => item.status === "insufficient")
    ? "degraded"
    : missing.length ? "warning" : "healthy";
  return [
    "# Tenant 摘要",
    tenant.status === "collected"
      ? `租户：${tenant.displayName || tenant.name}（${tenant.id}）`
      : `租户：未取得（${tenant.reason}）`,
    `Capability：${capabilities.length}`,
    `状态：${status}`,
    `证据：${missing.length ? "incomplete" : "complete"}`,
    "",
    "Capability：",
    ...(capabilities.length ? capabilities.map((fact) => fact.status === "collected"
      ? `- ${fact.service} · ${fact.capability}：${fact.result.facts.length} 条 Fact`
      : `- ${fact.service} · ${fact.capability}：未取得（${fact.reason}）`) : ["- 无"]),
    ...(missing.length ? ["", "证据缺口：", ...missing.map((reason) => `- ${reason}`)] : []),
    "", "[完整 Facts](raw/facts.json) · [诊断](diagnosis.json)",
    "",
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
      ...capabilitySummary(diagnosis),
    ]),
    htmlParagraph("Tenant Command 组合 Model Catalog 与接受 tenant_id 的 Inspect contribution，并将结果保留为 Facts。"),
    htmlHeading(2, "Coverage"),
    htmlList(diagnosis.coverage.flatMap((item) => [
      `${item.goal}：${item.status}`,
      ...item.missingEvidence.map((missing) => `缺失：${missing}`),
    ])),
  ].join("\n");
}

export function buildTenantHtmlSections(diagnosis: TenantDiagnosis): HtmlReportSection[] {
  return collectedCapabilities(diagnosis).map((fact) => {
    return {
      title: capabilityLabel(fact),
      html: htmlFactTable(fact.result.facts, {
        searchPlaceholder: `搜索 ${capabilityLabel(fact)} 关键字`,
      }) || `<p class="muted">已采集，0 条 Fact。</p>`,
    };
  });
}
