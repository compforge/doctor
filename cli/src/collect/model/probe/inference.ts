import {
  PROBE_RUNNABLE,
  probeUnavailable,
  probeUnnecessary,
  type Probe,
} from "../../protocol";
import { supportsImageInput } from "../../../model";
import { buildModelTestRequest } from "../config";
import type {
  ModelCommandContext,
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
): Probe<ModelObservation, ModelInspectionFacts, ModelDiagnosisConfig, ModelCommandContext> {
  return {
    id: MODEL_INFERENCE_PROBE_ID,
    dependsOn: [MODEL_PERFORMANCE_DECISION_PROBE_ID],
    evaluate: (_facts, _config, progress) => {
      const decision = progress[0]?.observations.find(
        (item): item is ModelPerformanceDecisionObservation =>
          item.kind === "model-performance-decision",
      );
      if (!decision) return probeUnavailable("未取得性能测试选择");
      if (decision.enabled && !supportsImageInput(model)) {
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
      ctx.log(
        `[model] POST ${model.inference.baseUrl}${request.path}`
        + (supportsImageInput(model) ? "（内置图片测试）" : ""),
      );
      let observation: ModelResponseObservation;
      try {
        const response = await ctx.inference.invoke(request.path, request.body);
        // TODO: HTTP 成功不能证明下游实际消费了图片。当前在诊断报告中保留原始模型响应供人工判断，
        // 等有 provider-neutral 的语义判定方式后再把图片识别准确性纳入自动诊断。
        observation = {
          id: MODEL_INFERENCE_PROBE_ID,
          kind: "model-inference",
          schemaVersion: 1,
          producer: { origin: "core", id: MODEL_INFERENCE_PROBE_ID },
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
          schemaVersion: 1,
          producer: { origin: "core", id: MODEL_INFERENCE_PROBE_ID },
          error: reason,
        };
        ctx.bundle.fill(MODEL_INFERENCE_PROBE_ID, { status: "failed", reason });
      }
      return [observation];
    },
  };
}
