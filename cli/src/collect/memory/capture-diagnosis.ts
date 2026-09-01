import type {
  Detector,
  Diagnosis,
  DiagnosisCoverage,
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
export type MemoryCaptureDiagnosisGoal = "memory-heap-artifact";
export type MemoryCaptureDiagnosis = Diagnosis<
  MemoryCaptureEvidence,
  MemoryCaptureFinding,
  MemoryCaptureDiagnosisGoal
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

export function buildMemoryCaptureCoverage(
  evidence: MemoryCaptureEvidence,
): DiagnosisCoverage<MemoryCaptureDiagnosisGoal>[] {
  const capture = memoryCaptureObservation(evidence)?.result;
  if (capture?.code === 0 && capture.heapPath && capture.capturePath) {
    return [{ goal: "memory-heap-artifact", status: "sufficient", missingEvidence: [] }];
  }
  const reasons = capture?.reasons?.length
    ? capture.reasons
    : [capture?.reason ?? "未形成可分析的 Python heap artifact"];
  return [{ goal: "memory-heap-artifact", status: "insufficient", missingEvidence: reasons }];
}
