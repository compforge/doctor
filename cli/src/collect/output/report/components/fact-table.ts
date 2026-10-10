import type { Fact, RelationFact } from "@compforge/doctor-plugin";
import { projectSummary } from "../../../../command/summary";
import { htmlTable, htmlTableDetailCell } from "./table";

const FACT_PREVIEW_LENGTH = 240;

function factKey(fact: Fact): string {
  if (fact.factType === "record") return fact.recordKey;
  if (fact.factType === "relation") {
    const relation = fact as RelationFact;
    return `${relation.from.kind}:${relation.from.value} → ${relation.to.kind}:${relation.to.value}`;
  }
  return "—";
}

export function htmlFactTable(
  facts: readonly Fact[],
  options: {
    metadataHeaders?: readonly string[];
    metadataCells?: (fact: Fact, index: number) => readonly unknown[];
    searchPlaceholder?: string;
  } = {},
): string {
  const hasText = facts.some(fact => fact.factType !== "relation" && fact.summary?.text);
  return htmlTable(
    ["key", ...(hasText ? ["summary"] : []), "data", "kind", "type", ...(options.metadataHeaders ?? [])],
    facts.map((fact, index) => {
      const key = factKey(fact);
      const compact = JSON.stringify(fact) ?? String(fact);
      const preview = compact.length > FACT_PREVIEW_LENGTH
        ? `${compact.slice(0, FACT_PREVIEW_LENGTH - 1)}…`
        : compact;
      return [
        key,
        ...(hasText ? [fact.factType !== "relation" && fact.summary
          ? projectSummary(fact.summary, fact.factType === "record" ? fact.record : fact.value).text ?? "—" : "—"] : []),
        htmlTableDetailCell(preview, JSON.stringify(fact, null, 2) ?? String(fact), `${fact.kind} · ${key}`),
        fact.kind,
        fact.factType,
        ...(options.metadataCells?.(fact, index) ?? []),
      ];
    }),
    { search: { placeholder: options.searchPlaceholder ?? "搜索 Fact 关键字" } },
  );
}
