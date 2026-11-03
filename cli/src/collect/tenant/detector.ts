import { evidenceGaps, type EvidenceGapFinding } from "../evidence-gaps";
import type { Detector, } from "../protocol";
import type {
  TenantEvidence,
  TenantFacts,
  TenantFinding,
} from "./model";

export const tenantDetectors: readonly Detector<TenantEvidence, TenantFinding>[] = [];

export function buildTenantEvidence(_observations: readonly never[], facts: TenantFacts): TenantEvidence {
  return { observations: [], facts };
}

export function detectTenantEvidenceGaps(
  evidence: TenantEvidence,
): EvidenceGapFinding[] {
  return evidence.facts.capabilityFacts.flatMap((fact) => {
    if (fact.status !== "collected") {
      return evidenceGaps(fact.id, [fact.reason], evidence);
    }
    const missingEvidence = [
      ...(fact.result.missingEvidence ?? []),
      ...(fact.result.truncated ? [`Facts 已截断：${fact.result.truncated.reason}`] : []),
    ];
    return evidenceGaps(fact.id, missingEvidence, evidence);
  });
}
