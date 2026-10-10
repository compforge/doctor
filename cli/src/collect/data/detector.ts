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
          producerId: result.extension ?? "inspect",
          factPath: `capabilityResults.${resultIndex}.result.facts.${factIndex}`,
          fact,
          query: result.identity,
          value: fact,
        }))
        : []
    )),
    observations: [],
    sources: evidence.facts.capabilityResults.flatMap((result, index) => (
      (result.status === "collected" ? result.result.sources : result.sources) ?? []
    ).map((source, sourceIndex) => ({
      factPath: `capabilityResults.${index}.${result.status === "collected" ? "result." : ""}sources.${sourceIndex}`,
      producer: { origin: "plugin" as const, plugin, service: result.service, id: result.extension ?? "inspect" },
      query: result.identity, result: source,
    }))),
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
    if (serviceFacts.inspect.status !== "collected") {
      missingEvidence.push(`${service} 数据不可查询：${serviceFacts.inspect.reason}`);
      continue;
    }
    const results = evidence.facts.capabilityResults.filter((item): item is CollectedDataInspectResult => (
      item.status === "collected" && item.service === service
    ));
    for (const item of evidence.facts.capabilityResults.filter(item => item.service === service)) {
      if (item.status !== "collected") missingEvidence.push(`${service} ${item.identity.kind}:${item.identity.value} ${item.status === "failed" ? "查询失败" : "未采集"}：${item.reason}`);
      const sources = item.status === "collected" ? item.result.sources : item.sources;
      for (const source of sources ?? []) {
        if (source.status === "failed" || source.status === "not_collected") {
          missingEvidence.push(`${service} ${source.source} ${source.status === "failed" ? "查询失败" : "未采集"}：${source.reason}`);
        }
      }
    }
    if (!results.length) {
      if (!evidence.facts.capabilityResults.some(item => item.service === service)) {
        missingEvidence.push(`${service} 业务记录未取得`);
      }
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
