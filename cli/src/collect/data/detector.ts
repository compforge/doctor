import type { ServiceCatalog, ServiceEvidence } from "@compforge/doctor-plugin";
import type { Detector, DiagnosisCoverage } from "../protocol";
import {
  makeServiceEvidenceDetectors,
} from "../../plugin/evidence-detector";
import { projectPluginServiceEvidenceFact } from "../../plugin/evidence";
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

export function projectDataServiceEvidence(evidence: DataEvidence, plugin: string): ServiceEvidence {
  return {
    facts: evidence.facts.capabilityResults.flatMap((result, resultIndex) => (
      result.status === "collected"
        ? result.result.facts.map((fact, factIndex) => projectPluginServiceEvidenceFact({
          plugin,
          service: result.service,
          producerId: "inspect",
          factPath: `capabilityResults.${resultIndex}.result.facts.${factIndex}`,
          fact,
          query: result.identity,
          value: fact,
        }))
        : []
    )),
    observations: [],
  };
}

export function makeDataDetectors(
  plugin: string,
  catalog: ServiceCatalog,
  services: readonly string[],
): readonly Detector<DataEvidence, DataFinding>[] {
  return makeServiceEvidenceDetectors<DataEvidence>({
    plugin,
    catalog,
    services,
    project: (evidence) => projectDataServiceEvidence(evidence, plugin),
  });
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
