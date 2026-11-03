import { evidenceGaps, type EvidenceGapFinding } from "../evidence-gaps";
import type {
  Detector,
  Diagnosis,
  Evidence,
  ObservationMeta,
} from "../protocol";
import type { CgroupMemoryTargetFacts } from "../fact/inspect";
import type { CaptureResult } from "./capture";

export type MemoryCaptureFacts = CgroupMemoryTargetFacts;

export interface MemoryCaptureObservation extends ObservationMeta {
  id: "memory-heap-capture";
  kind: "memory.heap-capture";
  result: CaptureResult;
}

export type MemoryCaptureEvidence = Evidence<MemoryCaptureObservation, MemoryCaptureFacts>;
export type MemoryCaptureFinding = never;
export type MemoryCaptureDiagnosis = Diagnosis<
  MemoryCaptureEvidence,
  MemoryCaptureFinding
>;

export const memoryCaptureDetectors: readonly Detector<
  MemoryCaptureEvidence,
  MemoryCaptureFinding
>[] = [];

export function buildMemoryCaptureEvidence(
  observations: MemoryCaptureEvidence["observations"],
  facts: MemoryCaptureEvidence["facts"],
): MemoryCaptureEvidence {
  return { observations, facts };
}

export function memoryCaptureObservation(
  evidence: MemoryCaptureEvidence,
): MemoryCaptureObservation | undefined {
  return evidence.observations.find(
    (item): item is MemoryCaptureObservation => item.kind === "memory.heap-capture",
  );
}

export function detectMemoryCaptureEvidenceGaps(
  evidence: MemoryCaptureEvidence,
): EvidenceGapFinding[] {
  const capture = memoryCaptureObservation(evidence)?.result;
  if (capture?.code === 0 && capture.heapPath && capture.capturePath) {
    return [...evidenceGaps("memory-heap-artifact", [], evidence)];
  }
  const reasons = capture?.reasons?.length
    ? capture.reasons
    : [capture?.reason ?? "未形成可分析的 Python heap artifact"];
  return [...evidenceGaps("memory-heap-artifact", reasons, evidence)];
}
