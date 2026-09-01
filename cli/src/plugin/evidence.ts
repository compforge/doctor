import type {
  Fact as PluginFact,
  Identity,
  ServiceEvidence,
  ServiceEvidenceFact,
  ServiceEvidenceObservation,
  WorkloadInstance,
} from "@compforge/doctor-plugin";
import type { EvidenceSchemaMeta, ObservationMeta } from "../collect/protocol";

/** Core canonicalizes local Plugin schema kinds instead of trusting hand-written prefixes. */
export function pluginEvidenceKind(plugin: string, service: string, kind: string): string {
  return `plugin/${plugin}/${service}/${kind}`;
}

/**
 * @spec A Core Service Fact projection preserves the source kind, schemaVersion, and producer exactly
 * @why Domains own disclosure, Service scope, factPath, and value shape; the shared boundary must not crawl arbitrary Evidence
 * @rule Do not add caller-supplied identity overrides that can drift from the persisted Fact
 */
export function projectServiceEvidenceFact(input: {
  factPath: string;
  services: readonly string[];
  source: EvidenceSchemaMeta;
  value: unknown;
  query?: Identity;
}): ServiceEvidenceFact {
  return {
    factPath: input.factPath,
    services: input.services,
    kind: input.source.kind,
    schemaVersion: input.source.schemaVersion,
    producer: input.source.producer,
    ...(input.query ? { query: input.query } : {}),
    value: input.value,
  };
}

/** Normalize one local Plugin Inspect Fact at the Core-owned Service Evidence boundary. */
export function projectPluginServiceEvidenceFact(input: {
  plugin: string;
  service: string;
  producerId: string;
  factPath: string;
  fact: Pick<PluginFact, "kind" | "schemaVersion">;
  value: unknown;
  query?: Identity;
}): ServiceEvidenceFact {
  return {
    factPath: input.factPath,
    services: [input.service],
    kind: pluginEvidenceKind(input.plugin, input.service, input.fact.kind),
    schemaVersion: input.fact.schemaVersion,
    producer: {
      origin: "plugin",
      plugin: input.plugin,
      service: input.service,
      id: input.producerId,
    },
    ...(input.query ? { query: input.query } : {}),
    value: input.value,
  };
}

/**
 * @spec A Core Service Observation projection preserves the persisted id and schema identity exactly
 * @why Observation payload disclosure and Service scope remain domain decisions rather than reflection over Evidence
 */
export function projectServiceEvidenceObservation(input: {
  services: readonly string[];
  probe: string;
  source: ObservationMeta;
  value: Readonly<Record<string, unknown>>;
  workload?: string;
  instance?: WorkloadInstance;
}): ServiceEvidenceObservation {
  return {
    id: input.source.id,
    services: input.services,
    probe: input.probe,
    kind: input.source.kind,
    schemaVersion: input.source.schemaVersion,
    producer: input.source.producer,
    ...(input.workload ? { workload: input.workload } : {}),
    ...(input.instance ? { instance: input.instance } : {}),
    value: input.value,
  };
}

/** Normalize one local Plugin Probe Observation at the Core-owned Service Evidence boundary. */
export function projectPluginServiceEvidenceObservation(input: {
  id: string;
  plugin: string;
  service: string;
  producerId: string;
  probe: string;
  kind: string;
  schemaVersion: number;
  value: Readonly<Record<string, unknown>>;
  workload?: string;
  instance?: WorkloadInstance;
}): ServiceEvidenceObservation {
  return {
    id: input.id,
    services: [input.service],
    probe: input.probe,
    kind: pluginEvidenceKind(input.plugin, input.service, input.kind),
    schemaVersion: input.schemaVersion,
    producer: {
      origin: "plugin",
      plugin: input.plugin,
      service: input.service,
      id: input.producerId,
    },
    ...(input.workload ? { workload: input.workload } : {}),
    ...(input.instance ? { instance: input.instance } : {}),
    value: input.value,
  };
}

function freezeDeep(value: unknown): unknown {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function immutableJson<T>(value: T, label: string): T {
  try {
    const serialized = JSON.stringify(value);
    return freezeDeep(JSON.parse(serialized)) as T;
  } catch (error) {
    throw new Error(
      `${label} must be JSON serializable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Freeze the complete projected Evidence before it crosses into a Service Detector. */
export function immutableServiceEvidence(evidence: ServiceEvidence): ServiceEvidence {
  return immutableJson(evidence, "Service Evidence");
}

/** Freeze the complete Inspect result before it crosses from Core into a Service Probe. */
export function immutableServiceProbeFacts(
  facts: readonly ServiceEvidenceFact[],
): readonly ServiceEvidenceFact[] {
  return immutableJson(facts, "Service Probe Facts");
}
