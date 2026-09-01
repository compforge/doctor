import { PROBE_RUNNABLE, probeUnavailable, type Probe } from "../../protocol";
import { resolveModelPerformanceEnabled } from "../config";
import type {
  ModelCommandContext,
  ModelDiagnosisConfig,
  ModelInspectionFacts,
  ModelObservation,
  ModelPerformanceDecisionObservation,
  ModelResponseObservation,
  SelectedInferenceModel,
} from "../model";
import { MODEL_VALIDATION_PROBE_ID } from "./validation";

export const MODEL_PERFORMANCE_DECISION_PROBE_ID = "model-performance-decision";

export function makeModelPerformanceDecisionProbe(
  model: SelectedInferenceModel,
): Probe<ModelObservation, ModelInspectionFacts, ModelDiagnosisConfig, ModelCommandContext> {
  return {
    id: MODEL_PERFORMANCE_DECISION_PROBE_ID,
    dependsOn: [MODEL_VALIDATION_PROBE_ID],
    evaluate: (_facts, _config, progress) => {
      const validation = progress[0]?.observations.find(
        (item): item is ModelResponseObservation => item.kind === "model-validation",
      );
      if (!validation) return probeUnavailable("validation 未取得 Observation");
      if (validation.error) return probeUnavailable(`validation 请求失败：${validation.error}`);
      if (!validation.response?.ok) {
        return probeUnavailable(`validation 返回 HTTP ${validation.response?.statusCode ?? "unknown"}`);
      }
      return PROBE_RUNNABLE;
    },
    onUnavailable: (ctx, reason) => {
      ctx.bundle.fill(MODEL_PERFORMANCE_DECISION_PROBE_ID, {
        status: "unavailable",
        reason,
      });
    },
    run: async (ctx, _facts, config) => {
      const enabled = model.type === "llm"
        ? await resolveModelPerformanceEnabled({
            enabled: config.performance,
            repeat: config.repeat,
          })
        : false;
      const observation: ModelPerformanceDecisionObservation = {
        id: MODEL_PERFORMANCE_DECISION_PROBE_ID,
        kind: "model-performance-decision",
        schemaVersion: 1,
        producer: { origin: "core", id: MODEL_PERFORMANCE_DECISION_PROBE_ID },
        enabled,
      };
      ctx.bundle.fill(MODEL_PERFORMANCE_DECISION_PROBE_ID, {
        status: "ok",
        output: `${JSON.stringify(observation, null, 2)}\n`,
        ext: "json",
      });
      return [observation];
    },
  };
}
