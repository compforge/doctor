import type { Intention, IntentionReference } from "@compforge/doctor-plugin";
import { htmlTable } from "../../output/html";
import type { TenantFacet } from "../facet";
import type { TenantFacts } from "../model";

const HEADERS = [
  "Name",
  "ID",
  "Scene",
  "Scene ID",
  "Action",
  "Enabled",
  "Level",
  "Sync Status",
  "Reference",
  "Examples",
  "Replies",
  "COT",
  "Report Template",
  "Created",
  "Updated",
  "Description",
] as const;

function intentionSnapshot(intention: Intention): Intention {
  return {
    id: intention.id,
    name: intention.name,
    actionType: intention.actionType,
    sceneId: intention.sceneId,
    sceneName: intention.sceneName,
    description: intention.description,
    enabled: intention.enabled,
    level: intention.level,
    syncStatus: intention.syncStatus,
    examples: intention.examples ? [...intention.examples] : undefined,
    replies: intention.replies ? [...intention.replies] : undefined,
    reference: intention.reference
      ? { id: intention.reference.id, type: intention.reference.type }
      : undefined,
    cot: intention.cot,
    reportTemplate: intention.reportTemplate,
    createdAt: intention.createdAt,
    updatedAt: intention.updatedAt,
  };
}

function booleanLabel(value: boolean | undefined): string {
  return value === undefined ? "—" : value ? "yes" : "no";
}

function referenceLabel(reference: IntentionReference | undefined): string {
  return reference ? `${reference.type}:${reference.id}` : "—";
}

function rows(facts: TenantFacts): string[][] {
  if (facts.intentions.status !== "collected") return [];
  return facts.intentions.items.map((intention) => [
    intention.name,
    intention.id,
    intention.sceneName ?? "—",
    intention.sceneId,
    intention.actionType,
    booleanLabel(intention.enabled),
    intention.level === undefined ? "—" : String(intention.level),
    intention.syncStatus ?? "—",
    referenceLabel(intention.reference),
    intention.examples?.join(" / ") || "—",
    intention.replies?.join(" / ") || "—",
    intention.cot ?? "—",
    intention.reportTemplate ?? "—",
    intention.createdAt ?? "—",
    intention.updatedAt ?? "—",
    intention.description ?? "—",
  ]);
}

function summary(facts: TenantFacts): string[] {
  const fact = facts.intentions;
  if (fact.status === "unavailable") return [];
  if (fact.status !== "collected") return [`Intention Catalog：未取得（${fact.reason}）`];
  const counts = new Map<string, number>();
  for (const intention of fact.items) {
    counts.set(intention.actionType, (counts.get(intention.actionType) ?? 0) + 1);
  }
  return [
    `Intentions：${fact.items.length}`,
    `动作类型：${[...counts].map(([type, count]) => `${type}=${count}`).join("，") || "—"}`,
  ];
}

export const INTENTION_TENANT_FACET: TenantFacet = {
  inspect: {
    id: "tenant-intention-catalog",
    run: async (ctx) => {
      if (!ctx.prepareIntentionCatalog) {
        return {
          intentions: { status: "unavailable", reason: "Plugin 未提供 intention capability" },
        };
      }

      const started = Date.now();
      try {
        ctx.intentionCatalog ??= await ctx.prepareIntentionCatalog();
        const items = (await ctx.intentionCatalog.list(ctx.config.tenant.id)).map(intentionSnapshot);
        ctx.bundle.addStep({
          id: "tenant-intention-catalog",
          title: "租户 Intention Catalog",
          risk: "observe",
          status: "ok",
          durationMs: Date.now() - started,
          output: JSON.stringify(items, null, 2),
          ext: "json",
        });
        return { intentions: { status: "collected", items } };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        ctx.bundle.addStep({
          id: "tenant-intention-catalog",
          title: "租户 Intention Catalog",
          risk: "observe",
          status: "failed",
          reason,
          durationMs: Date.now() - started,
        });
        return { intentions: { status: "failed", reason } };
      }
    },
  },
  coverage: (facts) => {
    if (facts.intentions.status === "unavailable") return undefined;
    return {
      goal: "intention-catalog",
      status: facts.intentions.status === "collected" ? "sufficient" : "insufficient",
      missingEvidence: facts.intentions.status === "collected" ? [] : [facts.intentions.reason],
    };
  },
  render: (facts) => {
    const intentionRows = rows(facts);
    return {
      summary: summary(facts),
      markdown: [
        "## Intentions",
        "",
        `| ${HEADERS.map((header) => header.toLowerCase()).join(" | ")} |`,
        `|${HEADERS.map(() => "---").join("|")}|`,
        ...intentionRows.map((row) => `| ${row.join(" | ")} |`),
        "",
      ],
      sections: [{
        title: "Tenant / Intentions",
        html: htmlTable(
          [...HEADERS],
          intentionRows,
          { search: { column: 0, placeholder: "按 Intention 名检索" } },
        ),
      }],
    };
  },
};
