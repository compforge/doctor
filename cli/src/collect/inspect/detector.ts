import type { Detector, DiagnosisCoverage } from "../protocol";
import type {
  ConfigurationComparisonRow,
  DependencyInventoryObservation,
  EnvironmentConfigObservation,
  InspectDiagnosisGoal,
  InspectEvidence,
  InspectFacts,
  InspectFinding,
  InspectObservation,
  JsonValue,
} from "./model";
import type { ServiceCatalog } from "@compforge/doctor-plugin";

function normalizeName(name: string): string {
  return name.trim().toUpperCase();
}

function stable(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function environmentObservations(
  observations: readonly InspectObservation[],
): EnvironmentConfigObservation[] {
  return observations.filter((item): item is EnvironmentConfigObservation => item.kind === "environment-config");
}

function dependencyObservations(
  observations: readonly InspectObservation[],
): DependencyInventoryObservation[] {
  return observations.filter(
    (item): item is DependencyInventoryObservation => item.kind === "dependency-inventory",
  );
}

export function buildInspectEvidence(
  observations: readonly InspectObservation[],
  facts: InspectFacts,
): InspectEvidence {
  const rows = new Map<string, {
    displayName: string;
    environment: Array<{ source: string; value: JsonValue }>;
  }>();
  const ensure = (name: string) => {
    const normalized = normalizeName(name);
    let row = rows.get(normalized);
    if (!row) {
      row = { displayName: name, environment: [] };
      rows.set(normalized, row);
    }
    return row;
  };
  for (const observation of environmentObservations(observations)) {
    for (const [name, value] of Object.entries(observation.values)) {
      ensure(name).environment.push({
        source: `${observation.service}/${observation.deployment}`,
        value,
      });
    }
  }
  const comparisonRows: ConfigurationComparisonRow[] = [...rows.values()].map((row) => {
    const distinctValues = new Set(row.environment.map((item) => stable(item.value)));
    const env = row.environment.length === 0
      ? undefined
      : distinctValues.size === 1
        ? row.environment[0]!.value
        : Object.fromEntries(row.environment.map((item) => [item.source, item.value]));
    return { name: row.displayName, env };
  }).sort((left, right) => left.name.localeCompare(right.name));
  return { observations, facts, rows: comparisonRows };
}

export const inspectDetectors: readonly Detector<InspectEvidence, InspectFinding>[] = [];

export function makeInspectDetectors(catalog: ServiceCatalog): readonly Detector<InspectEvidence, InspectFinding>[] {
  return [(evidence) => evidence.observations.flatMap((observation) => {
    if (observation.kind !== "plugin-workload") return [];
    const probe = catalog.find(observation.service)?.capabilities.workload?.probes.find(
      (candidate) => candidate.id === observation.probe && candidate.workload === observation.workload,
    );
    return (probe?.detect?.({ kind: observation.observationKind, value: observation.value }) ?? []).map((finding) => ({
      ...finding,
      id: `${observation.id}:${finding.id}`,
      evidence: [{ observationId: observation.id, role: "supporting" as const }],
    }));
  })];
}

export function buildInspectCoverage(
  evidence: InspectEvidence,
): DiagnosisCoverage<InspectDiagnosisGoal>[] {
  const environmentMissing: string[] = [];
  if (evidence.facts.deploymentConfiguration.status !== "collected") {
    environmentMissing.push(evidence.facts.deploymentConfiguration.reason);
  }
  if (evidence.facts.serviceTargets.status !== "collected") {
    environmentMissing.push(evidence.facts.serviceTargets.reason);
  } else if (evidence.facts.deploymentConfiguration.status !== "unavailable") {
    for (const [service, target] of Object.entries(evidence.facts.serviceTargets.services)) {
      if (!target.configurationSupported) continue;
      for (const workload of Object.values(target.workloads)) {
        if (!workload.deployments.length) environmentMissing.push(`${service}/${workload.name} 没有可采集的 Deployment/Container`);
        for (const deployment of workload.unavailableDeployments) {
          environmentMissing.push(`${service}/${workload.name}/${deployment.deployment}: ${deployment.reason}`);
        }
        for (const deployment of workload.deployments) {
          if (!environmentObservations(evidence.observations).some(
            (item) => item.service === service && item.deployment === deployment.deployment,
          )) {
            environmentMissing.push(`${service}/${workload.name}/${deployment.deployment} 未取得 Env 配置`);
          }
        }
      }
    }
  }
  const collectedEnvironment = environmentObservations(evidence.observations).length;
  const coverage: DiagnosisCoverage<InspectDiagnosisGoal>[] = [{
    goal: "environment-config",
    status: environmentMissing.length === 0 && collectedEnvironment > 0
      ? "sufficient"
      : collectedEnvironment > 0 ? "partial" : "insufficient",
    missingEvidence: environmentMissing,
  }];

  const workloadMissing: string[] = [];
  let workloadTargets = 0;
  let collectedWorkloads = 0;
  if (evidence.facts.serviceTargets.status !== "collected") {
    workloadMissing.push(evidence.facts.serviceTargets.reason);
  } else {
    for (const [service, target] of Object.entries(evidence.facts.serviceTargets.services)) {
      for (const workload of Object.values(target.workloads)) {
        workloadTargets += 1;
        if (workload.podRuntime.status === "collected") collectedWorkloads += 1;
        else workloadMissing.push(`${service}/${workload.name}: ${workload.podRuntime.reason}`);
      }
    }
  }
  coverage.push({
    goal: "workload-runtime",
    status: workloadTargets > 0 && collectedWorkloads === workloadTargets
      ? "sufficient"
      : collectedWorkloads > 0 ? "partial" : "insufficient",
    missingEvidence: workloadMissing,
  });

  const workloadObservationMissing: string[] = [];
  let expectedWorkloadObservations = 0;
  let collectedWorkloadObservations = 0;
  const pluginObservations = evidence.observations.filter((item) => item.kind === "plugin-workload");
  if (evidence.facts.serviceTargets.status === "collected") {
    for (const [serviceName, service] of Object.entries(evidence.facts.serviceTargets.services)) {
      for (const workload of Object.values(service.workloads)) {
        if (workload.podRuntime.status !== "collected") continue;
        for (const pod of workload.podRuntime.pods) {
          for (const probe of workload.probes) {
            expectedWorkloadObservations += 1;
            if (pluginObservations.some((item) => item.kind === "plugin-workload"
              && item.service === serviceName
              && item.workload === workload.name
              && item.pod === pod.pod
              && item.probe === probe)) {
              collectedWorkloadObservations += 1;
            } else {
              workloadObservationMissing.push(`${serviceName}/${workload.name}/${pod.pod}: 未取得 ${probe}`);
            }
          }
        }
      }
    }
  }
  coverage.push({
    goal: "workload-observations",
    status: expectedWorkloadObservations === 0 || collectedWorkloadObservations === expectedWorkloadObservations
      ? "sufficient"
      : collectedWorkloadObservations > 0 ? "partial" : "insufficient",
    missingEvidence: workloadObservationMissing,
  });

  const dependencyMissing: string[] = [];
  let collectedDependencies = 0;
  if (evidence.facts.dependencyTargets.status !== "collected") {
    dependencyMissing.push(evidence.facts.dependencyTargets.reason);
  } else {
    dependencyMissing.push(...evidence.facts.dependencyTargets.missing);
    const observationsById = new Map(
      dependencyObservations(evidence.observations).map((item) => [item.id, item]),
    );
    for (const target of evidence.facts.dependencyTargets.targets) {
      const observation = observationsById.get(target.id);
      if (!observation) {
        dependencyMissing.push(`${target.services.join(", ")}: 未取得应用依赖`);
      } else if (observation.status !== "collected") {
        dependencyMissing.push(
          `${target.services.join(", ")}: ${observation.reason ?? "依赖采集不可用"}`,
        );
      } else {
        collectedDependencies += 1;
        if (observation.truncated) {
          dependencyMissing.push(`${target.services.join(", ")}: 依赖数量超过采集上限`);
        }
      }
    }
  }
  const dependencyTargets = evidence.facts.dependencyTargets.status === "collected"
    ? evidence.facts.dependencyTargets.targets.length
    : 0;
  coverage.push({
    goal: "runtime-dependencies",
    status: dependencyTargets > 0
      && collectedDependencies === dependencyTargets
      && dependencyMissing.length === 0
      ? "sufficient"
      : collectedDependencies > 0 ? "partial" : "insufficient",
    missingEvidence: dependencyMissing,
  });
  return coverage;
}
