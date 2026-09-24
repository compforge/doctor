import {
  PROBE_RUNNABLE,
  probeUnavailable,
  probeUnnecessary,
  type Probe,
} from "../../protocol";
import { supportsImageInput } from "../../../model";
import { buildModelTestRequest } from "../config";
import type { Case } from "@compforge/spec-case/model";
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

function caseRequest(item: Case, model: SelectedInferenceModel): { path: string; body: Record<string, unknown> } {
  const path = item.input.path;
  const body = item.input.body;
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")
    || !body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(`Model Case '${item.id}' 需要 input.path 和 input.body 对象`);
  }
  if ("model" in body || "base_url" in body || "api_key" in body || ("stream" in body && body.stream === true)) {
    throw new Error(`Model Case '${item.id}' 不能指定 model/base_url/api_key 或流式请求；目标由 doctor model 注入`);
  }
  return { path, body: { ...body, model: model.inference.model } };
}

export function makeModelInferenceProbe(
  model: SelectedInferenceModel,
): Probe<ModelObservation, ModelInspectionFacts, ModelDiagnosisConfig, ModelCommandContext> {
  return {
    id: MODEL_INFERENCE_PROBE_ID,
    dependsOn: [MODEL_PERFORMANCE_DECISION_PROBE_ID],
    evaluate: (_facts, config, progress) => {
      if (config.selectedCases && !config.selectedCases.some((item) => item.facets?.mode !== "performance")) {
        return probeUnnecessary("本次未选择连通性 Case");
      }
      const decision = progress[0]?.observations.find(
        (item): item is ModelPerformanceDecisionObservation =>
          item.kind === "model-performance-decision",
      );
      if (!decision) return probeUnavailable("未取得性能测试选择");
      if (!config.selectedCases && decision.enabled && !supportsImageInput(model)) {
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
    run: async (ctx, _facts, config) => {
      const selected = config.selectedCases?.filter((item) => item.facets?.mode !== "performance");
      const cases = selected?.length ? selected : [undefined];
      const observations: ModelResponseObservation[] = [];
      for (const item of cases) {
        const observationId = item ? `${MODEL_INFERENCE_PROBE_ID}:${item.id}` : MODEL_INFERENCE_PROBE_ID;
        let observation: ModelResponseObservation;
        try {
          const request = item ? caseRequest(item, model) : buildModelTestRequest(model);
          ctx.log(`[model] case=${item?.id ?? "default"} POST ${model.inference.baseUrl}${request.path}`);
          const response = await ctx.inference.invoke(request.path, request.body);
          // TODO: HTTP 成功不能证明下游实际消费了图片。当前在诊断报告中保留原始模型响应供人工判断，
          // 等有 provider-neutral 的语义判定方式后再把图片识别准确性纳入自动诊断。
          observation = {
            id: observationId,
            kind: "model-inference",
            caseId: item?.id,
            schemaVersion: 1,
            producer: { origin: "core", id: MODEL_INFERENCE_PROBE_ID },
            response,
          };
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          observation = {
            id: observationId,
            kind: "model-inference",
            caseId: item?.id,
            schemaVersion: 1,
            producer: { origin: "core", id: MODEL_INFERENCE_PROBE_ID },
            error: reason,
          };
        }
        observations.push(observation);
      }
      const failed = observations.filter((item) => item.error || !item.response?.ok);
      ctx.bundle.fill(MODEL_INFERENCE_PROBE_ID, {
        status: failed.length ? "failed" : "ok",
        reason: failed.length ? `${failed.length}/${observations.length} 个 Case 请求失败` : undefined,
        durationMs: observations.reduce((sum, item) => sum + (item.response?.durationMs ?? 0), 0),
        output: `${JSON.stringify(observations, null, 2)}\n`, ext: "json",
      });
      return observations;
    },
  };
}
