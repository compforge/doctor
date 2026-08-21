import type { ModelPricing } from "@compforge/doctor-plugin";
import { modelSnapshot } from "../../../model";
import { htmlTable } from "../../output/html";
import type { TenantFacet } from "../facet";
import type { TenantFacts } from "../model";

const HEADERS = [
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

function rows(facts: TenantFacts): string[][] {
  if (facts.models.status !== "collected") return [];
  return facts.models.items.map((model) => [
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

function summary(facts: TenantFacts): string[] {
  const fact = facts.models;
  if (fact.status !== "collected") return [`模型目录：未取得（${fact.reason}）`];
  const counts = new Map<string, number>();
  for (const model of fact.items) counts.set(model.type, (counts.get(model.type) ?? 0) + 1);
  return [
    `可用模型：${fact.items.length}`,
    `类型：${[...counts].map(([type, count]) => `${type}=${count}`).join("，") || "—"}`,
  ];
}

export const MODEL_TENANT_FACET: TenantFacet = {
  inspect: {
    id: "tenant-model-catalog",
    run: async (ctx) => {
      const started = Date.now();
      try {
        const items = (await ctx.catalog.listAvailable(ctx.config.tenant.id)).map(modelSnapshot);
        ctx.bundle.addStep({
          id: "tenant-model-catalog",
          title: "租户可用模型目录",
          risk: "observe",
          status: "ok",
          durationMs: Date.now() - started,
          output: JSON.stringify(items, null, 2),
          ext: "json",
        });
        return { models: { status: "collected", items } };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        ctx.bundle.addStep({
          id: "tenant-model-catalog",
          title: "租户可用模型目录",
          risk: "observe",
          status: "failed",
          reason,
          durationMs: Date.now() - started,
        });
        return { models: { status: "failed", reason } };
      }
    },
  },
  coverage: (facts) => ({
    goal: "model-catalog",
    status: facts.models.status === "collected" ? "sufficient" : "insufficient",
    missingEvidence: facts.models.status === "collected" ? [] : [facts.models.reason],
  }),
  render: (facts) => {
    const modelRows = rows(facts);
    return {
      summary: summary(facts),
      markdown: [
        "## Models",
        "",
        `| ${HEADERS.map((header) => header.toLowerCase()).join(" | ")} |`,
        `|${HEADERS.map(() => "---").join("|")}|`,
        ...modelRows.map((row) => `| ${row.join(" | ")} |`),
        "",
      ],
      sections: [{
        title: "Tenant / Models",
        html: htmlTable(
          [...HEADERS],
          modelRows,
          { search: { column: 0, placeholder: "按模型名检索" } },
        ),
      }],
    };
  },
};
