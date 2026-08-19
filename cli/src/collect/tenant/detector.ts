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
  const coverage: DiagnosisCoverage<TenantDiagnosisGoal>[] = [{
    goal: "model-catalog",
    status: evidence.facts.models.status === "collected" ? "sufficient" : "insufficient",
    missingEvidence: evidence.facts.models.status === "collected" ? [] : [evidence.facts.models.reason],
  }];
  if (evidence.facts.configuration.status !== "unavailable") {
    const scopes = evidence.facts.configuration.status === "collected"
      ? Object.values(evidence.facts.configuration.scopes)
      : [];
    const collected = scopes.filter((scope) => scope.status === "collected").length;
    const missing = evidence.facts.configuration.status === "collected"
      ? Object.entries(evidence.facts.configuration.scopes).flatMap(([scope, fact]) => (
          fact.status === "collected" ? [] : [`${scope}: ${fact.reason}`]
        ))
      : [evidence.facts.configuration.reason];
    coverage.push({
      goal: "tenant-config",
      status: missing.length === 0 ? "sufficient" : collected > 0 ? "partial" : "insufficient",
      missingEvidence: missing,
    });
  }
  return coverage;
}
