import { PROBE_RUNNABLE, probeUnavailable, type Probe } from "../../protocol";
import type {
  ModelCommandContext,
  ModelDiagnosisConfig,
  ModelInspectionFacts,
  ModelObservation,
  ModelResponseObservation,
} from "../model";

export const MODEL_VALIDATION_PROBE_ID = "model-validation";

export const modelValidationProbe: Probe<
  ModelObservation,
  ModelInspectionFacts,
  ModelDiagnosisConfig,
  ModelCommandContext
> = {
  id: MODEL_VALIDATION_PROBE_ID,
  evaluate: (facts) => facts.backend.status === "collected"
    ? PROBE_RUNNABLE
    : probeUnavailable(facts.backend.reason),
  onUnavailable: (ctx, reason) => {
    ctx.bundle.fill(MODEL_VALIDATION_PROBE_ID, { status: "unavailable", reason });
  },
  run: async (ctx, _facts, config) => {
    if (!ctx.backend) {
      throw new Error("Model Inspect 已确认 backend，但运行上下文中缺少 Plugin backend handle");
    }
    let observation: ModelResponseObservation;
    try {
      const response = await ctx.backend.validate(config.timeoutMs);
      observation = {
        id: MODEL_VALIDATION_PROBE_ID,
        kind: "model-validation",
        response,
      };
      ctx.bundle.fill(MODEL_VALIDATION_PROBE_ID, {
        status: "ok",
        durationMs: response.durationMs,
        output: response.text,
        ext: "json",
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      observation = {
        id: MODEL_VALIDATION_PROBE_ID,
        kind: "model-validation",
        error: reason,
      };
      ctx.bundle.fill(MODEL_VALIDATION_PROBE_ID, {
        status: "failed",
        reason,
      });
    }
    return [observation];
  },
};
