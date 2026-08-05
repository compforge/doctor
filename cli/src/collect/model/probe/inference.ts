import {
  PROBE_RUNNABLE,
  probeUnavailable,
  probeUnnecessary,
  type Probe,
} from "../../protocol";
import { buildModelTestRequest } from "../config";
import type {
  ModelCollectContext,
  ModelDiagnosisConfig,
  ModelInspectionFacts,
  ModelObservation,
  ModelPerformanceDecisionObservation,
  ModelResponseObservation,
  SelectedInferenceModel,
} from "../model";
import { MODEL_PERFORMANCE_DECISION_PROBE_ID } from "./performance-decision";

export const MODEL_INFERENCE_PROBE_ID = "model-inference";

export function makeModelInferenceProbe(
  model: SelectedInferenceModel,
): Probe<ModelObservation, ModelInspectionFacts, ModelDiagnosisConfig, ModelCollectContext> {
  return {
    id: MODEL_INFERENCE_PROBE_ID,
    dependsOn: [MODEL_PERFORMANCE_DECISION_PROBE_ID],
    evaluate: (_facts, _config, progress) => {
      const decision = progress[0]?.observations.find(
        (item): item is ModelPerformanceDecisionObservation =>
          item.kind === "model-performance-decision",
      );
      if (!decision) return probeUnavailable("未取得性能测试选择");
      if (decision.enabled) {
        return probeUnnecessary("性能测试已覆盖 LLM inference");
      }
      return PROBE_RUNNABLE;
    },
    onUnavailable: (ctx, reason) => {
      ctx.bundle.fill(MODEL_INFERENCE_PROBE_ID, { status: "unavailable", reason });
    },
    onUnnecessary: (ctx, reason) => {
      ctx.bundle.fill(MODEL_INFERENCE_PROBE_ID, { status: "unnecessary", reason });
    },
    run: async (ctx) => {
      const request = buildModelTestRequest(model);
      ctx.log(`[model] POST ${model.inference.baseUrl}${request.path}`);
      let observation: ModelResponseObservation;
      try {
        const response = await ctx.inference.invoke(request.path, request.body);
        observation = {
          id: MODEL_INFERENCE_PROBE_ID,
          kind: "model-inference",
          response,
        };
        ctx.bundle.fill(MODEL_INFERENCE_PROBE_ID, {
          status: "ok",
          durationMs: response.durationMs,
          output: response.text,
          ext: "json",
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        observation = {
          id: MODEL_INFERENCE_PROBE_ID,
          kind: "model-inference",
          error: reason,
        };
        ctx.bundle.fill(MODEL_INFERENCE_PROBE_ID, { status: "failed", reason });
      }
      return [observation];
    },
  };
}
