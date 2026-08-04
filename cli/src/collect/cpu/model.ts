import type { Diagnosis, Evidence, FindingMeta } from "../protocol";
import type { ApprovalGate } from "../../command/approval";
import type { CpuDiagnosisFacts } from "./fact/model";
import type { CpuPySpyObservation } from "./py-spy-dump";
import type { CpuCollectContext } from "./context";
import type { CpuConfig } from "./config";

export type CpuObservation = CpuPySpyObservation;
export type CpuEvidence = Evidence<CpuObservation, CpuDiagnosisFacts>;
export type CpuFinding = FindingMeta<"cpu.thread-stack">;
export type CpuDiagnosisGoal = "python-thread-stacks";
export type CpuDiagnosis = Diagnosis<CpuEvidence, CpuFinding, CpuDiagnosisGoal>;

export interface CpuCheckOptions {
  config: CpuConfig;
  outputDir: string;
  approvalGate: ApprovalGate;
}

export interface CpuProbeContext extends Pick<
  CpuCollectContext,
  "exec" | "bundle" | "approvalGate" | "approvals" | "log" | "notes"
> {
  target: { pod: string; container?: string };
}

export function buildCpuEvidence(
  observations: readonly CpuObservation[],
  facts: CpuDiagnosisFacts,
): CpuEvidence {
  return { observations, facts };
}
