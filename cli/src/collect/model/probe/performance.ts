import { join } from "node:path";
import { captureHttpResponse, type SendHttp } from "../../shared/http/capture";
import type { HttpRequestPlan } from "../../shared/http/model";
import { SseCaptureObserver } from "../../shared/http/sse-observation";
import {
  PROBE_RUNNABLE,
  probeUnavailable,
  probeUnnecessary,
  type Probe,
} from "../../protocol";
import {
  buildModelPerformanceRequest,
  buildModelPerformanceSuite,
  OpenAiChatStreamObserver,
  type ModelPerformanceCase,
} from "../performance";
import type {
  ModelCommandContext,
  ModelDiagnosisConfig,
  ModelInspectionFacts,
  ModelObservation,
  ModelPerformanceDecisionObservation,
  ModelPerformanceObservation,
  ModelPerformanceWorkload,
  SelectedInferenceModel,
} from "../model";
import { MODEL_PERFORMANCE_DECISION_PROBE_ID } from "./performance-decision";

export const MODEL_PERFORMANCE_PROBE_ID = "model-performance";

export function modelPerformanceObservationId(caseId: string, round: number): string {
  return `model-performance:${caseId}:${round}`;
}

function logicalUrl(model: SelectedInferenceModel): string {
  return `${model.inference.baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

function requestPlan(
  model: SelectedInferenceModel,
  testCase: ModelPerformanceCase,
  requestBody: Record<string, unknown>,
  timeoutMs: number,
): HttpRequestPlan {
  return {
    requestId: testCase.id,
    entrypointId: "inference",
    method: "POST",
    url: logicalUrl(model),
    headers: { "Content-Type": "application/json" },
    body: new TextEncoder().encode(JSON.stringify(requestBody)),
    followRedirects: false,
    timeoutMs,
    maxResponseBytes: 8 * 1024 * 1024,
    expect: {
      status: [200],
      contentType: "text/event-stream",
    },
  };
}

function workload(testCase: ModelPerformanceCase): ModelPerformanceWorkload {
  return {
    id: testCase.id,
    label: testCase.label,
    kind: testCase.kind,
    promptCharacters: testCase.promptCharacters,
    maxOutputTokens: testCase.maxOutputTokens,
  };
}

export function makeModelPerformanceProbe(
  model: SelectedInferenceModel,
): Probe<ModelObservation, ModelInspectionFacts, ModelDiagnosisConfig, ModelCommandContext> {
  return {
    id: MODEL_PERFORMANCE_PROBE_ID,
    dependsOn: [MODEL_PERFORMANCE_DECISION_PROBE_ID],
    evaluate: (_facts, _config, progress) => {
      const decision = progress[0]?.observations.find(
        (item): item is ModelPerformanceDecisionObservation =>
          item.kind === "model-performance-decision",
      );
      if (!decision) return probeUnavailable("未取得性能测试选择");
      return decision.enabled
        ? PROBE_RUNNABLE
        : probeUnnecessary("用户未选择执行模型性能测试");
    },
    onUnavailable: (ctx, reason) => {
      ctx.bundle.fill(MODEL_PERFORMANCE_PROBE_ID, { status: "unavailable", reason });
    },
    onUnnecessary: (ctx, reason) => {
      ctx.bundle.fill(MODEL_PERFORMANCE_PROBE_ID, { status: "unnecessary", reason });
    },
    run: async (ctx, _facts, config) => {
      const observations: ModelPerformanceObservation[] = [];
      const suite = buildModelPerformanceSuite(config.maxOutputTokens);
      for (const testCase of suite) {
        for (let round = 0; round <= config.repeat; round += 1) {
          const warmup = round === 0;
          const sampleLabel = warmup ? "warmup" : `round-${String(round).padStart(3, "0")}`;
          ctx.log(
            `${warmup
              ? `[model] 性能采样 ${testCase.label} warmup（不计入结果）`
              : `[model] 性能采样 ${testCase.label} ${round}/${config.repeat}`}`
            + `（prompt_chars=${testCase.promptCharacters}, max_output_tokens=${testCase.maxOutputTokens}）`,
          );
          const requestBody = buildModelPerformanceRequest(
            model,
            testCase,
            `${testCase.id}:${sampleLabel}`,
          );
          const streamObserver = new OpenAiChatStreamObserver();
          const sseObserver = new SseCaptureObserver((frame) => streamObserver.observe(frame));
          const plan = requestPlan(model, testCase, requestBody, config.timeoutMs);
          const send: SendHttp = (_request, signal) =>
            ctx.inference.invokeStream("/chat/completions", requestBody, signal);
          const relativeDir = warmup
            ? join("warmup", testCase.id)
            : join("attempts", testCase.id, sampleLabel);
          const capture = await captureHttpResponse(
            plan,
            round,
            join(ctx.staging, relativeDir),
            relativeDir,
            send,
            sseObserver,
          );
          if (warmup) continue;
          observations.push({
            id: modelPerformanceObservationId(testCase.id, round),
            kind: "model-performance",
            schemaVersion: 1,
            producer: { origin: "core", id: MODEL_PERFORMANCE_PROBE_ID },
            workload: workload(testCase),
            round,
            capture,
            stream: streamObserver.result(),
          });
        }
      }
      const incomplete = observations.filter(
        (observation) => !observation.capture.response.captureComplete,
      );
      ctx.bundle.fill(MODEL_PERFORMANCE_PROBE_ID, {
        status: incomplete.length ? "failed" : "ok",
        reason: incomplete.length
          ? `${incomplete.length}/${observations.length} 个性能响应采集不完整`
          : undefined,
        durationMs: observations.reduce(
          (total, observation) => total + observation.capture.response.durationMs,
          0,
        ),
      });
      return observations;
    },
  };
}
