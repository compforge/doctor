import type { Detector, DiagnosisCoverage } from "../protocol";
import type {
  TenantDiagnosisGoal,
  TenantEvidence,
  TenantFacts,
  TenantFinding,
} from "./model";

export const tenantDetectors: readonly Detector<TenantEvidence, TenantFinding>[] = [];

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
    const missingEvidence = [
      ...(fact.result.missingEvidence ?? []),
      ...(fact.result.truncated ? [`Facts 已截断：${fact.result.truncated.reason}`] : []),
    ];
    return {
      goal: fact.id,
      status: missingEvidence.length ? "partial" : "sufficient",
      missingEvidence,
    };
  });
}
