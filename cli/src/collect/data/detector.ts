import type { ServiceCatalog } from "@compforge/doctor-plugin";
import type { Detector, DiagnosisCoverage } from "../protocol";
import type {
  DataDiagnosisGoal,
  DataEvidence,
  DataFinding,
  DataObservation,
} from "./model";

export function buildDataEvidence(
  observations: readonly DataObservation[],
  facts: DataEvidence["facts"],
): DataEvidence {
  return { observations, facts };
}

export function makeDataDetectors(
  catalog: ServiceCatalog,
): readonly Detector<DataEvidence, DataFinding>[] {
  const detectServiceDataResults: Detector<DataEvidence, DataFinding> = (evidence) => {
    const findings = new Map<string, DataFinding>();
    for (const observation of evidence.observations) {
      const declared = catalog.findWith(observation.service, "data");
      if (!declared) continue;
      for (const finding of declared.capabilities.data.detect(observation.result)) {
        const key = `${observation.service}:${finding.id}`;
        const existing = findings.get(key);
        const reference = { observationId: observation.id, role: "supporting" as const };
        if (existing) {
          findings.set(key, { ...existing, evidence: [...existing.evidence, reference] });
        } else {
          findings.set(key, {
            ...finding,
            service: observation.service,
            evidence: [reference],
          });
        }
      }
    }
    return [...findings.values()];
  };
  return [detectServiceDataResults];
}

export function buildDataCoverage(
  evidence: DataEvidence,
): DiagnosisCoverage<DataDiagnosisGoal>[] {
  const missingEvidence: string[] = [];
  let resolved = 0;
  const services = Object.entries(evidence.facts.services);
  for (const [service, serviceFacts] of services) {
    if (serviceFacts.target.status !== "collected") {
      missingEvidence.push(`${service} 目标不可用：${serviceFacts.target.reason}`);
      continue;
    }
    if (serviceFacts.capability.status !== "collected") {
      missingEvidence.push(`${service} 数据库不可查询：${serviceFacts.capability.reason}`);
      continue;
    }
    const observations = evidence.observations.filter((item) => item.service === service);
    if (!observations.length) {
      missingEvidence.push(`${service} 业务记录未取得`);
      continue;
    }
    if (!observations.some((item) => item.summary.resolvedAs !== "unresolved")) {
      missingEvidence.push(`${service} 未能把输入 ID 解析为已知业务对象`);
      continue;
    }
    resolved += 1;
  }
  return [{
    goal: "business-data-relations",
    status: resolved === services.length && services.length > 0
      ? "sufficient"
      : resolved > 0
        ? "partial"
        : "insufficient",
    missingEvidence,
  }];
}
