import type { Detector, DiagnosisCoverage } from "../protocol";
import type {
  ConfigComparisonRow,
  ConfigDiagnosisGoal,
  ConfigEvidence,
  ConfigFinding,
  ConfigInspectionFacts,
  ConfigObservation,
  DependencyInventoryObservation,
  EnvironmentConfigObservation,
  JsonValue,
  TenantConfigObservation,
} from "./model";

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
  observations: readonly ConfigObservation[],
): EnvironmentConfigObservation[] {
  return observations.filter((item): item is EnvironmentConfigObservation => item.kind === "environment-config");
}

function tenantObservations(observations: readonly ConfigObservation[]): TenantConfigObservation[] {
  return observations.filter((item): item is TenantConfigObservation => item.kind === "tenant-config");
}

function dependencyObservations(
  observations: readonly ConfigObservation[],
): DependencyInventoryObservation[] {
  return observations.filter(
    (item): item is DependencyInventoryObservation => item.kind === "dependency-inventory",
  );
}

export function buildConfigEvidence(
  observations: readonly ConfigObservation[],
  facts: ConfigInspectionFacts,
): ConfigEvidence {
  const rows = new Map<string, {
    displayName: string;
    environment: Array<{ source: string; value: JsonValue }>;
    tenantConfig?: { value: JsonValue; scope: string };
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
  for (const observation of tenantObservations(observations)) {
    for (const [name, value] of Object.entries(observation.values)) {
      ensure(name).tenantConfig = { value, scope: observation.scope };
    }
  }
  const comparisonRows: ConfigComparisonRow[] = [...rows.values()].map((row) => {
    const distinctValues = new Set(row.environment.map((item) => stable(item.value)));
    const env = row.environment.length === 0
      ? undefined
      : distinctValues.size === 1
        ? row.environment[0]!.value
        : Object.fromEntries(row.environment.map((item) => [item.source, item.value]));
    return { name: row.displayName, env, tenantConfig: row.tenantConfig };
  }).sort((left, right) => left.name.localeCompare(right.name));
  return { observations, facts, rows: comparisonRows };
}

export const configDetectors: readonly Detector<ConfigEvidence, ConfigFinding>[] = [];

export function buildConfigCoverage(
  evidence: ConfigEvidence,
): DiagnosisCoverage<ConfigDiagnosisGoal>[] {
  const environmentMissing: string[] = [];
  if (evidence.facts.deploymentConfiguration.status !== "collected") {
    environmentMissing.push(evidence.facts.deploymentConfiguration.reason);
  }
  if (evidence.facts.serviceTargets.status !== "collected") {
    environmentMissing.push(evidence.facts.serviceTargets.reason);
  } else if (evidence.facts.deploymentConfiguration.status !== "unavailable") {
    for (const [service, target] of Object.entries(evidence.facts.serviceTargets.services)) {
      if (!target.deployments.length) environmentMissing.push(`${service} 没有可采集的 Deployment/Container`);
      for (const deployment of target.unavailableDeployments) {
        environmentMissing.push(`${service}/${deployment.deployment}: ${deployment.reason}`);
      }
      for (const deployment of target.deployments) {
        if (!environmentObservations(evidence.observations).some(
          (item) => item.service === service && item.deployment === deployment.deployment,
        )) {
          environmentMissing.push(`${service}/${deployment.deployment} 未取得 Env 配置`);
        }
      }
    }
  }
  const collectedEnvironment = environmentObservations(evidence.observations).length;
  const coverage: DiagnosisCoverage<ConfigDiagnosisGoal>[] = [{
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
      workloadTargets += 1;
      if (target.podRuntime.status === "collected") collectedWorkloads += 1;
      else workloadMissing.push(`${service}: ${target.podRuntime.reason}`);
    }
  }
  coverage.push({
    goal: "workload-runtime",
    status: workloadTargets > 0 && collectedWorkloads === workloadTargets
      ? "sufficient"
      : collectedWorkloads > 0 ? "partial" : "insufficient",
    missingEvidence: workloadMissing,
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

  if (evidence.facts.tenantRequest.status === "collected") {
    const tenantRequest = evidence.facts.tenantRequest;
    const collectedScopes = new Set(tenantObservations(evidence.observations).map((item) => item.scope));
    const missing = tenantRequest.scopes
      .filter((scope) => !collectedScopes.has(scope))
      .map((scope) => `tenant=${tenantRequest.tenantId} scope=${scope} 配置未取得`);
    coverage.push({
      goal: "tenant-config",
      status: missing.length === 0 ? "sufficient" : collectedScopes.size > 0 ? "partial" : "insufficient",
      missingEvidence: missing,
    });
  }
  return coverage;
}
