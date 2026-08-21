import type { DiagnosisCoverage } from "../protocol";
import { TENANT_FACETS } from "./facets";
import type {
  TenantDiagnosisGoal,
  TenantEvidence,
  TenantFacts,
} from "./model";

export function buildTenantEvidence(_observations: readonly never[], facts: TenantFacts): TenantEvidence {
  return { observations: [], facts };
}

export function buildTenantCoverage(
  evidence: TenantEvidence,
): DiagnosisCoverage<TenantDiagnosisGoal>[] {
  return TENANT_FACETS.flatMap((facet) => {
    const coverage = facet.coverage(evidence.facts);
    return coverage ? [coverage] : [];
  });
}
