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
  return evidence.facts.capabilityFacts.map((fact) => {
    if (fact.status !== "collected") {
      return { goal: fact.id, status: "insufficient", missingEvidence: [fact.reason] };
    }
    const missingEvidence = fact.kind === "data" ? fact.result.missingEvidence ?? [] : [];
    return {
      goal: fact.id,
      status: missingEvidence.length ? "partial" : "sufficient",
      missingEvidence,
    };
  });
}
