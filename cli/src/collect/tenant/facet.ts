import type { Inspect } from "../inspection";
import type { HtmlReportSection } from "../output/html";
import type { DiagnosisCoverage } from "../protocol";
import type {
  TenantCommandContext,
  TenantDiagnosisGoal,
  TenantFacts,
} from "./model";

export interface TenantFacetView {
  summary: readonly string[];
  markdown: readonly string[];
  sections: readonly HtmlReportSection[];
}

/** Tenant facet owns one tenant-scoped fact family from collection through presentation. */
export interface TenantFacet {
  inspect: Inspect<TenantFacts, TenantCommandContext>;
  coverage(facts: TenantFacts): DiagnosisCoverage<TenantDiagnosisGoal> | undefined;
  render(facts: TenantFacts): TenantFacetView;
}
