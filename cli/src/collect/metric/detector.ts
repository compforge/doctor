import type { ServiceMetricDetector } from "@compforge/doctor-plugin";
import type { Detector, DiagnosisCoverage } from "../protocol";
import type {
  MetricDiagnosisGoal,
  MetricEvidence,
  MetricFinding,
  MetricQueryObservation,
  MetricWindowObservation,
} from "./model";

const FINDING_META = {
  schemaVersion: 1,
  producer: { origin: "core" as const, id: "metric-threshold" },
};

function queryObservations(evidence: MetricEvidence): MetricQueryObservation[] {
  return evidence.observations.filter(
    (item): item is MetricQueryObservation => item.kind === "metric-query",
  );
}

function metricWindow(evidence: MetricEvidence): MetricWindowObservation | undefined {
  return evidence.observations.find(
    (item): item is MetricWindowObservation => item.kind === "metric-window",
  );
}

export function buildMetricEvidence(
  observations: MetricEvidence["observations"],
  facts: MetricEvidence["facts"],
): MetricEvidence {
  return { observations, facts };
}

export function detectMetricValue(
  service: string,
  detector: ServiceMetricDetector,
  value: number | undefined,
  observationId: string,
  window?: MetricWindowObservation,
): MetricFinding | undefined {
  if (value === undefined || detector.operator !== "gt" || value <= detector.threshold) return undefined;
  return {
    ...FINDING_META,
    id: `${service}:${detector.id}`,
    kind: "metric.threshold-exceeded",
    service,
    title: detector.title,
    severity: detector.severity,
    confidence: "high",
    message: detector.message,
    value,
    threshold: detector.threshold,
    window: window ? {
      startedAt: new Date(window.startedAt).toISOString(),
      endedAt: new Date(window.finishedAt).toISOString(),
    } : undefined,
    evidence: [{ observationId, role: "supporting" }],
  };
}

export const metricDetectors: readonly Detector<MetricEvidence, MetricFinding>[] = [
  (evidence) => {
    const findings: MetricFinding[] = [];
    const window = metricWindow(evidence);
    for (const observation of queryObservations(evidence)) {
      if (observation.status !== "collected") continue;
      const values = observation.series.flatMap((series) => series.points.map((point) => point.value));
      const value = values.length ? Math.max(...values) : undefined;
      for (const consumer of observation.consumers) {
        if (consumer.kind !== "detector") continue;
        const finding = detectMetricValue(
          observation.service,
          consumer.definition,
          value,
          observation.id,
          window,
        );
        if (finding) findings.push(finding);
      }
    }
    return findings;
  },
];

export function buildMetricCoverage(
  evidence: MetricEvidence,
): DiagnosisCoverage<MetricDiagnosisGoal>[] {
  const coverage: DiagnosisCoverage<MetricDiagnosisGoal>[] = [];
  for (const observation of queryObservations(evidence)) {
    for (const consumer of observation.consumers) {
      const definition = consumer.definition;
      const goal = `metric:${observation.service}:${consumer.kind}:${definition.id}` as const;
      const missingEvidence = observation.status === "collected"
        ? []
        : [observation.status === "failed"
            ? `${observation.service} ${definition.title} PromQL 查询失败：${observation.error ?? "未知错误"}`
            : `${observation.service} ${definition.title} PromQL 未返回数据`];
      coverage.push({
        goal,
        status: observation.status === "collected" ? "sufficient" : "insufficient",
        missingEvidence,
      });
    }
  }
  return coverage;
}
