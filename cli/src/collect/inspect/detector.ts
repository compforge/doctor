import { evidenceGaps, type EvidenceGapFinding } from "../evidence-gaps";
import { containerEnvironmentTargets } from "./fact/inspect";
import type { Detector, } from "../protocol";
import type {
  ConfigSearchMatch,
  ConfigurationComparisonRow,
  InspectField,
  ImageSearchMatch,
  InspectSearchResult,
  DependencyInventoryObservation,
  EnvironmentConfigObservation,
  InspectEvidence,
  InspectFacts,
  InspectFinding,
  InspectObservation,
  JsonValue,
} from "./model";
import type {
  ServiceCatalog,
  ServiceEvidence,
  ServiceEvidenceFact,
  ServiceEvidenceObservation,
} from "@compforge/doctor-plugin";
import {
  makeServiceEvidenceDetectors,
} from "../../plugin/evidence-detector";
import {
  projectPluginServiceEvidenceObservation,
  projectServiceEvidenceFact,
  projectServiceEvidenceObservation,
} from "../../plugin/evidence";

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

/**
 * @spec Detail search matches literal substrings ignoring case and preserves each source.
 * @rule Search is a projection: full Observations, Detector inputs and Findings remain unchanged.
 * @see {@link cli/docs/commands/inspect.md}
 */
export function searchInspectFields(evidence: InspectEvidence, field: InspectField, keyword?: string): InspectSearchResult {
  const term = keyword?.toLowerCase() ?? "";
  const contains = (text: string) => text.toLowerCase().includes(term);
  if (field === "event" || field === "hpa") {
    const lifecycle = evidence.facts.lifecycleSignals;
    const selected = lifecycle.status === "collected" ? lifecycle : undefined;
    const matches = (item: object) => Object.values(item).some(value => contains(String(value ?? "")));
    return field === "event" ? { field, keyword, matches: (selected?.events ?? []).filter(matches) }
      : { field, keyword, matches: (selected?.autoscalers ?? []).filter(matches) };
  }
  if (field === "image") {
    const targets = evidence.facts.serviceTargets;
    const matches: ImageSearchMatch[] = [];
    if (targets.status === "collected") {
      for (const service of Object.values(targets.services)) {
        for (const workload of Object.values(service.workloads)) {
          if (workload.podRuntime.status !== "collected") continue;
          for (const pod of workload.podRuntime.pods) {
            for (const container of pod.containers) {
              if (!contains(container.image) && !contains(container.imageId ?? "")) continue;
              matches.push({ image: container.image, imageId: container.imageId,
                service: service.service, workload: workload.name, pod: pod.pod, container: container.name });
            }
          }
        }
      }
    }
    return { field, keyword, matches };
  }
  if (field === "config") {
    const matches: ConfigSearchMatch[] = evidence.observations.flatMap(observation => {
      if ((observation.kind !== "file-configuration" && observation.kind !== "container-environment") || observation.status !== "collected") return [];
      return Object.entries(observation.values).flatMap(([name, value]) => {
        if (!contains(name) && !contains(typeof value === "string" ? value : JSON.stringify(value))) return [];
        return [{ name, value, source: observation.kind === "file-configuration" ? "file" as const : "env" as const,
          service: observation.service, workload: observation.workload, pod: observation.pod, container: observation.container,
          ...(observation.kind === "file-configuration" ? { namespace: observation.namespace, path: observation.path } : {}) }];
      });
    });
    return { field, keyword, matches };
  }
  return { field, keyword,
    matches: evidence.observations.flatMap(observation => observation.kind === "container-environment" && observation.status === "collected"
      ? Object.entries(observation.values).flatMap(([name, value]) => contains(name) || contains(value)
        ? [{ name, value, service: observation.service, workload: observation.workload, pod: observation.pod, container: observation.container }]
        : [])
      : []),
  };
}

export const inspectDetectors: readonly Detector<InspectEvidence, InspectFinding>[] = [];

/** Public, schema-identified projection shared by every selected Service Probe and Detector. */
export function projectInspectServiceFacts(
  facts: InspectFacts,
  services: readonly string[],
): ServiceEvidenceFact[] {
  return [
    projectServiceEvidenceFact({
      factPath: "serviceTargets",
      services,
      source: facts.serviceTargets,
      value: facts.serviceTargets,
    }),
    projectServiceEvidenceFact({
      factPath: "deploymentConfiguration",
      services,
      source: facts.deploymentConfiguration,
      value: facts.deploymentConfiguration,
    }),
    projectServiceEvidenceFact({
      factPath: "dependencyTargets",
      services,
      source: facts.dependencyTargets,
      value: facts.dependencyTargets,
    }),
    projectServiceEvidenceFact({
      factPath: "lifecycleSignals",
      services,
      source: facts.lifecycleSignals,
      value: facts.lifecycleSignals,
    }),
  ];
}

export function projectInspectServiceEvidence(
  evidence: InspectEvidence,
  plugin: string,
  services: readonly string[],
): ServiceEvidence {
  return {
    facts: projectInspectServiceFacts(evidence.facts, services),
    observations: evidence.observations.flatMap<ServiceEvidenceObservation>((observation) => {
      if (observation.kind === "plugin-workload") {
        return [projectPluginServiceEvidenceObservation({
          id: observation.id,
          plugin,
          service: observation.service,
          producerId: observation.probe,
          probe: observation.probe,
          kind: observation.observationKind,
          schemaVersion: observation.observationSchemaVersion,
          workload: observation.workload,
          instance: observation.instance,
          value: observation.value,
        })];
      }
      if (observation.kind === "kubernetes-apparmor-unconfined-admission") {
        return [projectServiceEvidenceObservation({
          services: [observation.service],
          probe: observation.probe,
          source: observation,
          value: {
            namespace: observation.namespace,
            serviceAccountName: observation.serviceAccountName,
            status: observation.status,
            ...(observation.reason ? { reason: observation.reason } : {}),
          },
        })];
      }
      if (observation.kind === "file-configuration") return [projectServiceEvidenceObservation({
        services: [observation.service], probe: "file-configuration", source: observation,
        value: { workload: observation.workload, path: observation.path, status: observation.status, values: observation.values,
          ...(observation.namespace ? { namespace: observation.namespace } : {}),
          ...(observation.pod ? { pod: observation.pod } : {}), ...(observation.container ? { container: observation.container } : {}),
          ...(observation.reason ? { reason: observation.reason } : {}) },
      })];
      if (observation.kind === "container-environment") {
        return [projectServiceEvidenceObservation({
          services: [observation.service], probe: "container-environment", source: observation,
          value: { workload: observation.workload, pod: observation.pod, container: observation.container,
            status: observation.status, values: observation.values, ...(observation.reason ? { reason: observation.reason } : {}) },
        })];
      }
      if (observation.kind === "environment-config") {
        return [projectServiceEvidenceObservation({
          services: [observation.service],
          probe: "environment-config",
          source: observation,
          value: {
            deployment: observation.deployment,
            container: observation.container,
            values: observation.values,
          },
        })];
      }
      if (observation.kind === "dependency-inventory") {
        return [projectServiceEvidenceObservation({
          services: observation.services,
          probe: "dependency-inventory",
          source: observation,
          value: {
            pod: observation.pod,
            container: observation.container,
            image: observation.image,
            ...(observation.imageId ? { imageId: observation.imageId } : {}),
            toolchain: observation.toolchain,
            status: observation.status,
            ...(observation.runtimeVersion ? { runtimeVersion: observation.runtimeVersion } : {}),
            dependencies: observation.dependencies,
            ...(observation.truncated === undefined ? {} : { truncated: observation.truncated }),
            ...(observation.reason ? { reason: observation.reason } : {}),
          },
        })];
      }
      return [];
    }),
  };
}

export function makeInspectDetectors(
  plugin: string,
  catalog: ServiceCatalog,
  services: readonly string[],
): readonly Detector<InspectEvidence, InspectFinding>[] {
  return [
    ...inspectDetectors,
    ...makeServiceEvidenceDetectors<InspectEvidence>({
      plugin,
      catalog,
      services,
      project: (evidence) => projectInspectServiceEvidence(evidence, plugin, services),
    }),
  ];
}

export function detectInspectEvidenceGaps(
  evidence: InspectEvidence,
  scope?: { includeDeploymentConfig?: boolean; includeDependencies?: boolean; field?: InspectField },
): EvidenceGapFinding[] {
  const environmentMissing: string[] = [];
  if (evidence.facts.deploymentConfiguration.status !== "collected") {
    environmentMissing.push(evidence.facts.deploymentConfiguration.reason);
  }
  if (evidence.facts.serviceTargets.status !== "collected") {
    environmentMissing.push(evidence.facts.serviceTargets.reason);
  } else if (evidence.facts.deploymentConfiguration.status !== "unavailable") {
    for (const [service, target] of Object.entries(evidence.facts.serviceTargets.services)) {
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
  const findings: EvidenceGapFinding[] = [...evidenceGaps("environment-config", environmentMissing, evidence)];

  const workloadMissing: string[] = [];
  if (evidence.facts.serviceTargets.status !== "collected") {
    workloadMissing.push(evidence.facts.serviceTargets.reason);
  } else {
    for (const [service, target] of Object.entries(evidence.facts.serviceTargets.services)) {
      for (const workload of Object.values(target.workloads)) {
        if (workload.podRuntime.status !== "collected") workloadMissing.push(`${service}/${workload.name}: ${workload.podRuntime.reason}`);
      }
    }
  }
  findings.push(...evidenceGaps("workload-runtime", workloadMissing, evidence, [{ factPath: "serviceTargets", role: "supporting" }]));

  const workloadObservationMissing: string[] = [];
  const pluginObservations = evidence.observations.filter((item) => item.kind === "plugin-workload");
  if (evidence.facts.serviceTargets.status === "collected") {
    for (const [serviceName, service] of Object.entries(evidence.facts.serviceTargets.services)) {
      for (const workload of Object.values(service.workloads)) {
        if (workload.podRuntime.status !== "collected") continue;
        for (const pod of workload.podRuntime.pods) {
          for (const probe of workload.probes) {
            const observation = pluginObservations.find((item) => item.kind === "plugin-workload"
              && item.service === serviceName
              && item.workload === workload.name
              && item.pod === pod.pod
              && item.probe === probe);
            if (!observation) {
              workloadObservationMissing.push(`${serviceName}/${workload.name}/${pod.pod}: 未取得 ${probe}`);
            } else if (observation.status && observation.status !== "ok") {
              workloadObservationMissing.push(`${serviceName}/${workload.name}/${pod.pod}: ${observation.reason ?? `${probe} 未完成`}`);
            }
          }
        }
      }
    }
  }
  findings.push(...evidenceGaps("workload-observations", workloadObservationMissing, evidence, [
    { factPath: "serviceTargets", role: "context" },
    ...pluginObservations.filter(item => item.status && item.status !== "ok").map(item => ({ observationId: item.id, role: "supporting" as const })),
  ]));

  const dependencyMissing: string[] = [];
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
        if (observation.truncated) {
          dependencyMissing.push(`${target.services.join(", ")}: 依赖数量超过采集上限`);
        }
      }
    }
  }
  findings.push(...evidenceGaps("runtime-dependencies", dependencyMissing, evidence));
  if (scope?.field === "env" || scope?.field === "config") {
    const { targets, missing } = containerEnvironmentTargets(evidence.facts);
    for (const target of targets) {
      const observation = evidence.observations.find(item => item.kind === "container-environment"
        && item.service === target.service && item.workload === target.workload
        && item.pod === target.pod && item.container === target.container);
      if (observation?.kind !== "container-environment" || observation.status !== "collected") missing.push(`${target.service}/${target.workload}/${target.pod}/${target.container}: ${
        observation?.kind === "container-environment" ? observation.reason ?? "Env 不可用" : "未取得 Pod Env"}`);
    }
    findings.push(...evidenceGaps("container-environment", missing, evidence));
  }
  if (scope?.field === "config") {
    const missing: string[] = [];
    if (evidence.facts.serviceTargets.status !== "collected") missing.push(evidence.facts.serviceTargets.reason);
    else for (const service of Object.values(evidence.facts.serviceTargets.services)) {
      for (const file of service.files ?? []) {
        const observation = evidence.observations.find(item => item.kind === "file-configuration" && item.id === file.id);
        if (observation?.kind !== "file-configuration" || observation.status !== "collected") missing.push(observation?.kind === "file-configuration" && observation.reason
          ? observation.reason : `${service.service}/${file.workload} ${file.path}: 未取得配置文件`);
      }
    }
    findings.push(...evidenceGaps("file-configuration", missing, evidence));
  }
  if (scope?.field === "event" || scope?.field === "hpa") {
    const fact = evidence.facts.lifecycleSignals;
    const truncated = scope.field === "event" && fact.status === "collected" && !!fact.omittedEvents;
    findings.push(...evidenceGaps(scope.field, fact.status !== "collected" ? [fact.reason] : truncated ? [`容量限制省略 ${fact.omittedEvents} 条事件`] : [], evidence));
  }
  if (scope?.field) {
    const subjects: Record<InspectField, string[]> = {
      env: ["workload-runtime", "container-environment"],
      config: ["workload-runtime", "container-environment", "file-configuration"],
      image: ["workload-runtime"], event: ["workload-runtime", "event"], hpa: ["workload-runtime", "hpa"],
    };
    return findings.filter(item => subjects[scope.field!].includes(item.subject));
  }
  // Diagnose the selected scope; optional evidence does not imply an unrequested diagnostic obligation.
  return findings.filter(({ subject }) => !scope
    || (subject !== "environment-config" || scope.includeDeploymentConfig)
      && (subject !== "runtime-dependencies" || scope.includeDependencies));
}
