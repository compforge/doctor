import type { DiagnosisCoverage } from "../protocol";
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
  return Object.entries(evidence.facts.contributions).map(([id, fact]) => {
    if (fact.status !== "collected") {
      return { goal: id, status: "insufficient", missingEvidence: [fact.reason] };
    }
    const missingEvidence = fact.missingEvidence ?? [];
    return {
      goal: id,
      status: missingEvidence.length ? "partial" : "sufficient",
      missingEvidence,
    };
  });
}
