import type { Detector, DiagnosisCoverage } from "../protocol";
import type {
  LogDiagnosisGoal,
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

function insufficient(
  goal: LogDiagnosisGoal,
  reason: string,
): DiagnosisCoverage<LogDiagnosisGoal> {
  return { goal, status: "insufficient", missingEvidence: [reason] };
}

export function buildLogCoverage(
  evidence: LogEvidence,
): DiagnosisCoverage<LogDiagnosisGoal>[] {
  if (evidence.facts.runtime.status !== "collected") {
    return [insufficient("log:runtime", evidence.facts.runtime.reason)];
  }
  if (evidence.facts.servicePods.status !== "collected") {
    return [insufficient("log:service-pods", evidence.facts.servicePods.reason)];
  }

  const coverage = evidence.observations.flatMap((observation) => {
    if (!observation.pods.length) {
      return [insufficient(
        `log:service:${observation.service}`,
        `Service ${observation.service} 没有可采集日志的运行中 Pod`,
      )];
    }
    return observation.pods.map((pod): DiagnosisCoverage<LogDiagnosisGoal> => {
      if (pod.captureStatus === "complete") {
        return {
          goal: `log:pod:${observation.service}:${pod.pod}`,
          status: "sufficient",
          missingEvidence: [],
        };
      }
      return {
        goal: `log:pod:${observation.service}:${pod.pod}`,
        status: pod.captureStatus === "partial" ? "partial" : "insufficient",
        missingEvidence: [pod.captureStatus === "partial"
          ? `Pod ${pod.pod} 只取得部分 current 日志`
          : `Pod ${pod.pod} 的 current 日志不可用`],
      };
    });
  });

  return coverage.length
    ? coverage
    : [insufficient("log:collection", "Log Probe 未返回任何 Service 日志证据")];
}
