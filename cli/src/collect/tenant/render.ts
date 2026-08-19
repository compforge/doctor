import type { ModelPricing } from "@compforge/doctor-plugin";
import {
  htmlHeading,
  htmlList,
  htmlParagraph,
  htmlTable,
  type HtmlReportSection,
} from "../output/html";
import type { TenantDiagnosis, TenantJsonValue } from "./model";

function display(value: TenantJsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

const MODEL_HEADERS = [
  "Name",
  "ID",
  "Type",
  "Provider",
  "Vendor",
  "Version",
  "Available",
  "Preset",
  "Billing",
  "Context",
  "Dimension",
  "Modalities",
  "Capacities",
  "Features",
  "Pricing",
  "Source Model",
  "Created",
  "Updated",
  "Description",
] as const;

function booleanLabel(value: boolean | undefined): string {
  return value === undefined ? "—" : value ? "yes" : "no";
}

function pricingLabel(pricing: ModelPricing): string {
  return `${pricing.currency} input=${pricing.input}, output=${pricing.output} (${pricing.type}/${pricing.unit})`;
}

function modelRows(diagnosis: TenantDiagnosis): string[][] {
  if (diagnosis.evidence.facts.models.status !== "collected") return [];
  return diagnosis.evidence.facts.models.items.map((model) => [
    model.name,
    model.id,
    model.type,
    model.provider,
    model.vendor ?? "—",
    model.version ?? "—",
    booleanLabel(model.available),
    booleanLabel(model.preset),
    booleanLabel(model.billing),
    model.contextLength ?? "—",
    model.dimension === undefined ? "—" : String(model.dimension),
    model.inputModalities?.join(", ") || "—",
    model.capacities?.join(", ") || "—",
    model.features?.join(", ") || "—",
    model.pricing ? pricingLabel(model.pricing) : "—",
    model.sourceModelId ?? "—",
    model.createdAt ?? "—",
    model.updatedAt ?? "—",
    model.description ?? "—",
  ]);
}

function configRows(diagnosis: TenantDiagnosis): string[][] {
  const config = diagnosis.evidence.facts.configuration;
  if (config.status !== "collected") return [];
  return Object.entries(config.scopes).flatMap(([scope, fact]) => (
    fact.status === "collected"
      ? Object.entries(fact.values).map(([name, value]) => [scope, name, display(value)])
      : [[scope, "—", `unavailable: ${fact.reason}`]]
  ));
}

function modelSummary(diagnosis: TenantDiagnosis): string[] {
  const fact = diagnosis.evidence.facts.models;
  if (fact.status !== "collected") return [`模型目录：未取得（${fact.reason}）`];
  const counts = new Map<string, number>();
  for (const model of fact.items) counts.set(model.type, (counts.get(model.type) ?? 0) + 1);
  return [
    `可用模型：${fact.items.length}`,
    `类型：${[...counts].map(([type, count]) => `${type}=${count}`).join("，") || "—"}`,
  ];
}

export function buildTenantSummary(diagnosis: TenantDiagnosis): string {
  const tenant = diagnosis.evidence.facts.tenant;
  const models = modelRows(diagnosis);
  const configs = configRows(diagnosis);
  return [
    "# Tenant Inspect",
    "",
    tenant.status === "collected"
      ? `- 租户：${tenant.displayName || tenant.name}（${tenant.id}）`
      : `- 租户：未取得（${tenant.reason}）`,
    ...modelSummary(diagnosis).map((line) => `- ${line}`),
    `- 租户配置项：${configs.length}`,
    "",
    "## Coverage",
    "",
    ...diagnosis.coverage.flatMap((item) => [
      `- ${item.goal}：${item.status}`,
      ...item.missingEvidence.map((missing) => `  - 缺失：${missing}`),
    ]),
    "",
    "## Models",
    "",
    `| ${MODEL_HEADERS.map((header) => header.toLowerCase()).join(" | ")} |`,
    `|${MODEL_HEADERS.map(() => "---").join("|")}|`,
    ...models.map((row) => `| ${row.join(" | ")} |`),
    "",
    "## Tenant configuration",
    "",
    `| scope | name | value |`,
    `|---|---|---|`,
    ...configs.map((row) => `| ${row.join(" | ")} |`),
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
      ...modelSummary(diagnosis),
      `租户配置项：${configRows(diagnosis).length}`,
    ]),
    htmlParagraph("模型目录和租户配置均为只读 Inspect Facts；本命令不执行 validation 或 inference。"),
    htmlHeading(2, "Coverage"),
    htmlList(diagnosis.coverage.flatMap((item) => [
      `${item.goal}：${item.status}`,
      ...item.missingEvidence.map((missing) => `缺失：${missing}`),
    ])),
  ].join("\n");
}

export function buildTenantHtmlSections(diagnosis: TenantDiagnosis): HtmlReportSection[] {
  return [{
    title: "Tenant / Models",
    html: htmlTable(
      [...MODEL_HEADERS],
      modelRows(diagnosis),
      { search: { column: 0, placeholder: "按模型名检索" } },
    ),
  }, {
    title: "Tenant / Configuration",
    html: htmlTable(
      ["Scope", "Name", "Value"],
      configRows(diagnosis),
      { search: { column: 1, placeholder: "按配置名检索" } },
    ),
  }];
}
