import type { Evidence, EvidenceRef, FindingMeta, ObservationMeta } from "./protocol";

/** A diagnostic limitation, never a collection status or a judgement of target health. */
export interface EvidenceGapFinding extends FindingMeta<"evidence.insufficient"> {
  subject: string;
  message: string;
  summary: string;
}

export function evidenceGaps(
  subject: string,
  reasons: readonly string[],
  evidence: Evidence<ObservationMeta>,
  references?: readonly EvidenceRef[],
): EvidenceGapFinding[] {
  if (!reasons.length) return [];
  const message = [...new Set(reasons)].join("；");
  return [{
    id: `evidence-insufficient:${subject}`,
    kind: "evidence.insufficient",
    schemaVersion: 1,
    producer: { origin: "core", id: "evidence-gaps" },
    severity: "info",
    confidence: "high",
    subject,
    message,
    summary: message,
    evidence: references ?? [
      ...Object.keys(evidence.facts as object).map(factPath => ({ factPath, role: "context" as const })),
      ...evidence.observations.map(item => ({ observationId: item.id, role: "context" as const })),
    ],
  }];
}

export function gapMessages(findings: readonly FindingMeta<string>[]): string[] {
  return findings.filter((finding): finding is EvidenceGapFinding => finding.kind === "evidence.insufficient")
    .map(finding => finding.message);
}
