import type { Probe } from "../../protocol";
import type {
  ModelCommandContext,
  ModelDiagnosisConfig,
  ModelInspectionFacts,
  ModelObservation,
  SelectedInferenceModel,
} from "../model";
import { makeModelPerformanceProbe } from "./performance";
import { makeModelPerformanceDecisionProbe } from "./performance-decision";
import { makeModelInferenceProbe } from "./inference";
import { modelValidationProbe } from "./validation";

export * from "./performance";
export * from "./performance-decision";
export * from "./inference";
export * from "./validation";

export function makeModelProbes(
  model: SelectedInferenceModel,
): readonly Probe<
  ModelObservation,
  ModelInspectionFacts,
  ModelDiagnosisConfig,
  ModelCommandContext
>[] {
  return [
    modelValidationProbe,
    makeModelPerformanceDecisionProbe(model),
    makeModelInferenceProbe(model),
    makeModelPerformanceProbe(model),
  ];
}
