import type {
  Detector,
  Evidence,
  EvidenceRef,
  FindingMeta,
  ObservationMeta,
} from "./protocol";
import { isNonEmptyString, validateEvidenceSchemaMeta } from "./evidence-identity";

const ROLES = new Set(["supporting", "contradicting", "context"]);
const SEVERITIES = new Set(["info", "warning", "critical"]);
const CONFIDENCES = new Set(["low", "medium", "high"]);

function collectFactPaths(value: unknown): Set<string> {
  const paths = new Set<string>();
  const visited = new WeakSet<object>();
  const visit = (current: unknown, parent: string): void => {
    if (!current || typeof current !== "object" || visited.has(current)) return;
    visited.add(current);
    for (const [key, child] of Object.entries(current)) {
      const path = parent ? `${parent}.${key}` : key;
      paths.add(path);
      visit(child, path);
    }
  };
  visit(value, "");
  return paths;
}

function validateReference(
  reference: EvidenceRef,
  label: string,
  observationIds: ReadonlySet<string>,
  factPaths: ReadonlySet<string>,
): void {
  if (!reference || typeof reference !== "object") {
    throw new Error(`${label} must be an Evidence reference`);
  }
  if (!ROLES.has(reference.role)) throw new Error(`${label}.role '${reference.role}' is unsupported`);
  const hasObservationId = "observationId" in reference;
  const hasFactPath = "factPath" in reference;
  if (hasObservationId === hasFactPath) {
    throw new Error(`${label} must reference exactly one factPath or observationId`);
  }
  if (hasObservationId) {
    if (!isNonEmptyString(reference.observationId)) {
      throw new Error(`${label}.observationId must be a non-empty string`);
    }
    if (!observationIds.has(reference.observationId)) {
      throw new Error(`${label} references unknown Observation '${reference.observationId}'`);
    }
    return;
  }
  if (!isNonEmptyString(reference.factPath)) {
    throw new Error(`${label}.factPath must be a non-empty string`);
  }
  if (!factPaths.has(reference.factPath)) {
    throw new Error(`${label} references unknown Fact '${reference.factPath}'`);
  }
}

function validateFinding(
  finding: FindingMeta<string>,
  label: string,
  observationIds: ReadonlySet<string>,
  factPaths: ReadonlySet<string>,
): void {
  if (!finding || typeof finding !== "object") throw new Error(`${label} must be a Finding`);
  if (!isNonEmptyString(finding.id)) {
    throw new Error(`${label}.id must be a non-empty string`);
  }
  validateEvidenceSchemaMeta(finding, label);
  if (!SEVERITIES.has(finding.severity)) {
    throw new Error(`${label}.severity '${finding.severity}' is unsupported`);
  }
  if (!CONFIDENCES.has(finding.confidence)) {
    throw new Error(`${label}.confidence '${finding.confidence}' is unsupported`);
  }
  if (!Array.isArray(finding.evidence) || finding.evidence.length === 0) {
    throw new Error(`${label}.evidence must be a non-empty array`);
  }
  finding.evidence.forEach((reference, index) => validateReference(
    reference,
    `${label}.evidence[${index}]`,
    observationIds,
    factPaths,
  ));
}

/**
 * Run pure Core and adapted Plugin Detectors over the same Evidence boundary.
 *
 * @spec Evidence Observation ids and emitted Finding ids are unique; every Finding has schema identity, structured producer and valid Evidence references
 * @rule Finding contract violations are implementation bugs and must abort Collect rather than degrade Coverage
 */
export function runDetectors<
  DomainEvidence extends Evidence<ObservationMeta>,
  DomainFinding extends FindingMeta<string>,
>(
  detectors: readonly Detector<DomainEvidence, DomainFinding>[],
  evidence: DomainEvidence,
): DomainFinding[] {
  const observationIds = new Set<string>();
  for (const observation of evidence.observations) {
    if (observationIds.has(observation.id)) {
      throw new Error(`duplicate observation id in Evidence: ${observation.id}`);
    }
    observationIds.add(observation.id);
  }
  const factPaths = collectFactPaths(evidence.facts);
  const findingIds = new Set<string>();
  const findings: DomainFinding[] = [];
  detectors.forEach((detector, detectorIndex) => {
    const produced = detector(evidence);
    if (!Array.isArray(produced)) throw new Error(`detector[${detectorIndex}] must return an array`);
    produced.forEach((finding, findingIndex) => {
      const label = `detector[${detectorIndex}] finding[${findingIndex}]`;
      validateFinding(finding, label, observationIds, factPaths);
      if (findingIds.has(finding.id)) throw new Error(`duplicate finding id: ${finding.id}`);
      findingIds.add(finding.id);
      findings.push(finding);
    });
  });
  return findings;
}
