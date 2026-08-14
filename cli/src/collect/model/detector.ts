import type { CoverageBuilder, Detector, DiagnosisCoverage } from "../protocol";
import type {
  ModelDiagnosisConfig,
  ModelDiagnosisGoal,
  ModelEvidence,
  ModelFinding,
  ModelObservation,
  ModelPerformanceDecisionObservation,
  ModelPerformanceObservation,
  ModelResponseObservation,
} from "./model";
import {
  analyzeModelPerformanceObservation,
  summarizeModelPerformance,
  type ModelPerformanceAttempt,
  type ModelPerformanceSummary,
} from "./performance";

// 超过 1 秒的语义 SSE event 停顿已能被用户直接感知；控制帧、usage 和 DONE 不参与。
export const MODEL_ICL_WARNING_MS = 1_000;

export function buildModelEvidence(
  observations: readonly ModelObservation[],
  facts: ModelEvidence["facts"],
): ModelEvidence {
  return { observations, facts };
}

export function modelResponseObservation(
  evidence: ModelEvidence,
  kind: ModelResponseObservation["kind"],
): ModelResponseObservation | undefined {
  return evidence.observations.find(
    (item): item is ModelResponseObservation => item.kind === kind,
  );
}

export function modelPerformanceObservations(
  evidence: ModelEvidence,
): ModelPerformanceObservation[] {
  return evidence.observations.filter(
    (item): item is ModelPerformanceObservation => item.kind === "model-performance",
  );
}

export function modelPerformanceDecision(
  evidence: ModelEvidence,
): ModelPerformanceDecisionObservation | undefined {
  return evidence.observations.find(
    (item): item is ModelPerformanceDecisionObservation =>
      item.kind === "model-performance-decision",
  );
}

export function modelPerformanceAttempts(
  evidence: ModelEvidence,
): ModelPerformanceAttempt[] {
  return modelPerformanceObservations(evidence).map(analyzeModelPerformanceObservation);
}

export function modelPerformanceSummaries(
  evidence: ModelEvidence,
): ModelPerformanceSummary[] {
  return summarizeModelPerformance(modelPerformanceAttempts(evidence));
}

function responseFailure(
  observation: ModelResponseObservation,
  kind: "model.validation-failed" | "model.inference-failed",
): ModelFinding | undefined {
  if (!observation.error && observation.response?.ok) return undefined;
  const label = observation.kind === "model-validation" ? "模型 validation" : "模型推理请求";
  const reason = observation.error
    ?? `HTTP ${observation.response?.statusCode ?? "unknown"} ${observation.response?.statusText ?? ""}`.trim();
  return {
    id: kind,
    kind,
    severity: "critical",
    confidence: "high",
    evidence: [{ observationId: observation.id, role: "supporting" }],
    summary: `${label}失败：${reason}`,
  };
}

export const detectModelFindings: Detector<ModelEvidence, ModelFinding> = (evidence) => {
  const findings: ModelFinding[] = [];
  const validation = modelResponseObservation(evidence, "model-validation");
  if (validation) {
    const finding = responseFailure(validation, "model.validation-failed");
    if (finding) findings.push(finding);
  } else if (evidence.facts.backend.status !== "collected") {
    findings.push({
      id: "model.validation-failed",
      kind: "model.validation-failed",
      severity: "critical",
      confidence: "high",
      evidence: [{ factPath: "backend", role: "supporting" }],
      summary: `无法执行模型 validation：${evidence.facts.backend.reason}`,
    });
  }

  const inference = modelResponseObservation(evidence, "model-inference");
  if (inference) {
    const finding = responseFailure(inference, "model.inference-failed");
    if (finding) findings.push(finding);
  }

  const attempts = modelPerformanceAttempts(evidence);
  for (const attempt of attempts) {
    const observationId = `model-performance:${attempt.caseId}:${attempt.round}`;
    if (!attempt.success) {
      findings.push({
        id: `model.performance-sample-failed:${attempt.caseId}:${attempt.round}`,
        kind: "model.performance-sample-failed",
        severity: "critical",
        confidence: "high",
        evidence: [{ observationId, role: "supporting" }],
        caseId: attempt.caseId,
        round: attempt.round,
        summary: `${attempt.caseLabel}第 ${attempt.round} 轮失败：${attempt.error ?? "unknown"}`,
      });
    } else if (
      attempt.promptTokens === undefined
      || (attempt.kind === "decode" && attempt.tpotMs === undefined)
    ) {
      const reason = attempt.promptTokens === undefined
        ? "响应未返回 usage，无法确认实际 ISL"
        : attempt.tokenMetricsUnavailableReason ?? "无法计算 TPOT";
      findings.push({
        id: `model.performance-token-metrics-unavailable:${attempt.caseId}:${attempt.round}`,
        kind: "model.performance-token-metrics-unavailable",
        severity: attempt.kind === "decode" ? "warning" : "info",
        confidence: "high",
        evidence: [{ observationId, role: "supporting" }],
        caseId: attempt.caseId,
        round: attempt.round,
        summary: `${attempt.caseLabel}第 ${attempt.round} 轮 token 指标不可用：${reason}`,
      });
    }
    if (
      attempt.success
      && attempt.maxInterChunkLatencyMs !== undefined
      && attempt.maxInterChunkLatencyMs > MODEL_ICL_WARNING_MS
    ) {
      findings.push({
        id: `model.performance-icl-high:${attempt.caseId}:${attempt.round}`,
        kind: "model.performance-icl-high",
        severity: "warning",
        confidence: "high",
        evidence: [{ observationId, role: "supporting" }],
        caseId: attempt.caseId,
        round: attempt.round,
        interChunkLatencyP95Ms: attempt.p95InterChunkLatencyMs,
        interChunkLatencyMaxMs: attempt.maxInterChunkLatencyMs,
        expectedMaxMs: MODEL_ICL_WARNING_MS,
        summary: `${attempt.caseLabel}第 ${attempt.round} 轮 ICL 最大值 `
          + `${attempt.maxInterChunkLatencyMs}ms，超过 ${MODEL_ICL_WARNING_MS}ms`,
      });
    }
  }

  for (const summary of summarizeModelPerformance(attempts)) {
    if (summary.successful === 0 || summary.successful === summary.total) continue;
    findings.push({
      id: `model.performance-intermittent:${summary.caseId}`,
      kind: "model.performance-intermittent",
      severity: "warning",
      confidence: "high",
      evidence: attempts
        .filter((attempt) => attempt.caseId === summary.caseId)
        .map((attempt) => ({
          observationId: `model-performance:${attempt.caseId}:${attempt.round}`,
          role: attempt.success ? "contradicting" as const : "supporting" as const,
        })),
      caseId: summary.caseId,
      summary: `${summary.caseLabel}采样成功 ${summary.successful}/${summary.total}，推理服务存在间歇性失败`,
    });
  }
  return findings;
};

export const modelDetectors = [detectModelFindings] as const;

export function buildModelCoverage(
  config: ModelDiagnosisConfig,
): CoverageBuilder<ModelEvidence, ModelDiagnosisGoal> {
  return (evidence): DiagnosisCoverage<ModelDiagnosisGoal>[] => {
    const validation = modelResponseObservation(evidence, "model-validation");
    const coverage: DiagnosisCoverage<ModelDiagnosisGoal>[] = [{
      goal: "validation",
      status: validation?.response ? "sufficient" : "insufficient",
      missingEvidence: validation?.response
        ? []
        : [validation?.error ?? "模型 validation 响应"],
    }];
    const decision = modelPerformanceDecision(evidence);
    const performanceExpected = decision?.enabled ?? config.performance === true;
    if (!performanceExpected) {
      const inference = modelResponseObservation(evidence, "model-inference");
      const inferenceSucceeded = inference?.response?.ok === true && !inference.error;
      coverage.push({
        goal: "inference",
        status: inferenceSucceeded ? "sufficient" : "insufficient",
        missingEvidence: inferenceSucceeded
          ? []
          : [inference?.error ?? "模型推理响应"],
      });
      return coverage;
    }

    const observations = modelPerformanceObservations(evidence);
    const attempts = observations.map(analyzeModelPerformanceObservation);
    const expected = config.repeat * 4;
    const usable = attempts.filter((attempt) =>
      attempt.success
      && attempt.promptTokens !== undefined
      && (attempt.kind === "prefill" || attempt.tpotMs !== undefined)
    ).length;
    coverage.push({
      goal: "performance",
      status: usable === expected
        ? "sufficient"
        : observations.length > 0
          ? "partial"
          : "insufficient",
      missingEvidence: usable === expected
        ? []
        : [`指标可用的性能样本 ${usable}/${expected}`],
    });
    return coverage;
  };
}
