import { evidenceGaps, type EvidenceGapFinding } from "../evidence-gaps";
import type { Detector, } from "../protocol";
import type {
  LogEvidence,
  LogFinding,
} from "./model";

export const logDetectors: readonly Detector<LogEvidence, LogFinding>[] = [];

export function buildLogEvidence(
  observations: LogEvidence["observations"],
  facts: LogEvidence["facts"],
): LogEvidence {
  return { observations, facts };
}

export function detectLogEvidenceGaps(
  evidence: LogEvidence,
): EvidenceGapFinding[] {
  if (evidence.facts.runtime.status !== "collected") {
    return evidenceGaps("log:runtime", [evidence.facts.runtime.reason], evidence);
  }
  if (evidence.facts.servicePods.status !== "collected") {
    return evidenceGaps("log:service-pods", [evidence.facts.servicePods.reason], evidence);
  }

  const targets = evidence.facts.servicePods;
  const findings = evidence.observations.flatMap((observation) => {
    const gaps = targets.missing[observation.service] ?? [];
    const discovery: EvidenceGapFinding[] = gaps.length ? [...evidenceGaps(`log:service:${observation.service}`, gaps, evidence)] : [];
    if (!observation.pods.length) {
      return discovery.length ? discovery : evidenceGaps(
        `log:service:${observation.service}`,
        [`Service ${observation.service} 没有可采集日志的运行中 Pod`], evidence
      );
    }
    return [...discovery, ...observation.pods.flatMap((pod): EvidenceGapFinding[] => {
      if (pod.captureStatus === "complete") {
        return evidenceGaps(`log:pod:${observation.service}:${pod.pod}`, [], evidence);
      }
      return evidenceGaps(`log:pod:${observation.service}:${pod.pod}`, [pod.captureStatus === "partial"
          ? `Pod ${pod.pod} 只取得部分 current 日志`
          : `Pod ${pod.pod} 的 current 日志不可用`], evidence);
    })];
  });

  return evidence.observations.length ? findings
    : evidenceGaps("log:collection", ["Log Probe 未返回任何 Service 日志证据"], evidence);
}
