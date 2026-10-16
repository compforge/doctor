export * from "../../../datasource/opensearch/model";
import type { Diagnosis, Evidence } from "../../protocol";
import type { VdbInspectionFacts } from "./fact/model";
import type { VdbObservation, VdbFinding, VdbDiagnosisGoal } from "../../../datasource/opensearch/model";
export type VdbEvidence = Evidence<VdbObservation, VdbInspectionFacts>;
export type VdbDiagnosis = Diagnosis<VdbEvidence, VdbFinding, VdbDiagnosisGoal>;
