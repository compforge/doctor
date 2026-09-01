import type {
  ServiceCatalog,
  ServiceEvidence,
  ServiceEvidenceFact,
  ServiceEvidenceReference,
  ServiceFinding,
} from "@compforge/doctor-plugin";
import type {
  Detector,
  Evidence,
  ObservationMeta,
} from "../collect/protocol";

const ROLES = new Set(["supporting", "contradicting", "context"]);
const SEVERITIES = new Set(["info", "warning", "critical"]);
const CONFIDENCES = new Set(["low", "medium", "high"]);

export interface ServiceDetectorFinding extends ServiceFinding {
  /** Service that owns the detector, attached by Core rather than trusted to Plugin output. */
  service: string;
  /** Stable Service-local detector identity. */
  detector: string;
  producer: {
    origin: "plugin";
    plugin: string;
    service: string;
    id: string;
  };
}

/** Core canonicalizes local Plugin schema kinds instead of trusting hand-written prefixes. */
export function pluginEvidenceKind(plugin: string, service: string, kind: string): string {
  return `plugin/${plugin}/${service}/${kind}`;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
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

function immutableEvidence(value: ServiceEvidence): ServiceEvidence {
  return immutableJson(value, "Service Evidence");
}

/** Freeze the complete Inspect result before it crosses from Core into a Service Probe. */
export function immutableServiceProbeFacts(
  facts: readonly ServiceEvidenceFact[],
): readonly ServiceEvidenceFact[] {
  return immutableJson(facts, "Service Probe Facts");
}

function validateReference(input: {
  value: unknown;
  label: string;
  factPaths: ReadonlySet<string>;
  observationIds: ReadonlySet<string>;
}): ServiceEvidenceReference {
  const { label, factPaths, observationIds } = input;
  const reference = record(input.value, label);
  const role = nonEmptyString(reference.role, `${label}.role`);
  if (!ROLES.has(role)) throw new Error(`${label}.role '${role}' is unsupported`);
  const hasFactPath = reference.factPath !== undefined;
  const hasObservationId = reference.observationId !== undefined;
  if (hasFactPath === hasObservationId) {
    throw new Error(`${label} must reference exactly one factPath or observationId`);
  }
  if (hasFactPath) {
    const factPath = nonEmptyString(reference.factPath, `${label}.factPath`);
    if (!factPaths.has(factPath)) throw new Error(`${label} references unknown Fact '${factPath}'`);
    return { factPath, role: role as ServiceEvidenceReference["role"] };
  }
  const observationId = nonEmptyString(reference.observationId, `${label}.observationId`);
  if (!observationIds.has(observationId)) {
    throw new Error(`${label} references unknown Observation '${observationId}'`);
  }
  return { observationId, role: role as ServiceEvidenceReference["role"] };
}

function validateFindings(input: {
  value: unknown;
  plugin: string;
  service: string;
  detector: string;
  evidence: ServiceEvidence;
}): ServiceDetectorFinding[] {
  const { plugin, service, detector, evidence } = input;
  const label = `${service}.detectors.${detector}`;
  if (!Array.isArray(input.value)) throw new Error(`${label}.detect must return an array`);
  const factPaths = new Set(evidence.facts.map((fact) => fact.factPath));
  const observationIds = new Set(evidence.observations.map((observation) => observation.id));
  const ids = new Set<string>();
  return input.value.map((value, index) => {
    const findingLabel = `${label}.findings[${index}]`;
    const finding = record(value, findingLabel);
    const id = nonEmptyString(finding.id, `${findingLabel}.id`);
    if (ids.has(id)) throw new Error(`${label}.detect returned duplicate Finding id '${id}'`);
    ids.add(id);
    const localKind = nonEmptyString(finding.kind, `${findingLabel}.kind`);
    if (!Number.isInteger(finding.schemaVersion) || Number(finding.schemaVersion) < 1) {
      throw new Error(`${findingLabel}.schemaVersion must be a positive integer`);
    }
    const severity = nonEmptyString(finding.severity, `${findingLabel}.severity`);
    if (!SEVERITIES.has(severity)) throw new Error(`${findingLabel}.severity '${severity}' is unsupported`);
    const confidence = nonEmptyString(finding.confidence, `${findingLabel}.confidence`);
    if (!CONFIDENCES.has(confidence)) throw new Error(`${findingLabel}.confidence '${confidence}' is unsupported`);
    const message = nonEmptyString(finding.message, `${findingLabel}.message`);
    if (!Array.isArray(finding.evidence) || finding.evidence.length === 0) {
      throw new Error(`${findingLabel}.evidence must be a non-empty array`);
    }
    const references = finding.evidence.map((reference, referenceIndex) => validateReference({
      value: reference,
      label: `${findingLabel}.evidence[${referenceIndex}]`,
      factPaths,
      observationIds,
    }));
    const normalized = {
      ...finding,
      id: `service-detector:${service}:${detector}:${id}`,
      kind: pluginEvidenceKind(plugin, service, localKind),
      schemaVersion: Number(finding.schemaVersion),
      severity: severity as ServiceFinding["severity"],
      confidence: confidence as ServiceFinding["confidence"],
      message,
      evidence: references,
      service,
      detector,
      producer: { origin: "plugin" as const, plugin, service, id: detector },
    } satisfies ServiceDetectorFinding;
    try {
      const serialized = JSON.stringify(normalized);
      return JSON.parse(serialized) as ServiceDetectorFinding;
    } catch (error) {
      throw new Error(
        `${findingLabel} must be JSON serializable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
}

/** Adapt selected Plugin Service detectors to one Core Detector over a command-owned Evidence projection. */
export function makeServiceEvidenceDetectors<DomainEvidence extends Evidence<ObservationMeta>>(input: {
  plugin: string;
  catalog: ServiceCatalog;
  services: readonly string[];
  project(evidence: DomainEvidence): ServiceEvidence;
}): readonly Detector<DomainEvidence, ServiceDetectorFinding>[] {
  const selected = new Set(input.services);
  const declarations = input.catalog.services.flatMap((service) => (
    selected.has(service.name)
      ? (service.contributions?.detectors ?? []).map((detector) => ({ service: service.name, detector }))
      : []
  ));
  if (!declarations.length) return [];
  return [(evidence) => {
    const projected = immutableEvidence(input.project(evidence));
    return declarations.flatMap(({ service, detector }) => validateFindings({
      value: detector.detect(projected),
      plugin: input.plugin,
      service,
      detector: detector.id,
      evidence: projected,
    }));
  }];
}
