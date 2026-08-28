import type { ServiceCatalog } from "@compforge/doctor-plugin";
import type { Detector, DiagnosisCoverage } from "../protocol";
import type {
  CollectedDataInspectResult,
  DataDiagnosisGoal,
  DataEvidence,
  DataFinding,
  DataFacts,
} from "./model";

export function buildDataEvidence(
  _observations: readonly never[],
  facts: DataFacts,
): DataEvidence {
  return { observations: [], facts };
}

export function makeDataDetectors(
  catalog: ServiceCatalog,
): readonly Detector<DataEvidence, DataFinding>[] {
  const detectServiceInspectResults: Detector<DataEvidence, DataFinding> = (evidence) => {
    const findings = new Map<string, DataFinding>();
    for (const [index, result] of evidence.facts.capabilityResults.entries()) {
      if (result.status !== "collected") continue;
      const declared = catalog.findWith(result.service, "inspect");
      if (!declared) continue;
      for (const finding of declared.capabilities.inspect.detect(result.result)) {
        const key = `${result.service}:${finding.id}`;
        const existing = findings.get(key);
        const reference = { factPath: `capabilityResults.${index}`, role: "supporting" as const };
        if (existing) {
          findings.set(key, { ...existing, evidence: [...existing.evidence, reference] });
        } else {
          findings.set(key, {
            ...finding,
            service: result.service,
            evidence: [reference],
          });
        }
      }
    }
    return [...findings.values()];
  };
  return [detectServiceInspectResults];
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
    if (serviceFacts.inspect.status !== "collected") {
      missingEvidence.push(`${service} 数据库不可查询：${serviceFacts.inspect.reason}`);
      continue;
    }
    const results = evidence.facts.capabilityResults.filter((item): item is CollectedDataInspectResult => (
      item.status === "collected" && item.service === service
    ));
    if (!results.length) {
      const failures = evidence.facts.capabilityResults.flatMap((item) => (
        item.status !== "collected" && item.service === service
          ? [`${item.identity.kind}:${item.identity.value}: ${item.reason}`]
          : []
      ));
      missingEvidence.push(
        failures.length
          ? `${service} 业务记录未取得：${failures.join("；")}`
          : `${service} 业务记录未取得`,
      );
      continue;
    }
    if (!results.some((item) => item.result.resolution.resolvedAs !== "unresolved")) {
      missingEvidence.push(`${service} 未能把输入 ID 解析为已知业务对象`);
      continue;
    }
    for (const result of results) {
      missingEvidence.push(...(result.result.missingEvidence ?? []).map((reason) => `${service}：${reason}`));
      if (result.result.truncated) {
        missingEvidence.push(`${service} 业务 Facts 已截断：${result.result.truncated.reason}`);
      }
    }
    resolved += 1;
  }
  return [{
    goal: "business-data-relations",
    status: resolved === services.length && services.length > 0 && !missingEvidence.length
      ? "sufficient"
      : resolved > 0
        ? "partial"
        : "insufficient",
    missingEvidence,
  }];
}
