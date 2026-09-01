import type { EvidenceProducer, EvidenceSchemaMeta } from "./protocol";

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateProducer(producer: EvidenceProducer, label: string): void {
  if (!producer || typeof producer !== "object") {
    throw new Error(`${label}.producer must be a structured producer`);
  }
  if (producer.origin === "core") {
    if (!isNonEmptyString(producer.id)) {
      throw new Error(`${label}.producer.id must be a non-empty string`);
    }
    return;
  }
  if (producer.origin === "plugin") {
    if (
      !isNonEmptyString(producer.plugin)
      || !isNonEmptyString(producer.service)
      || !isNonEmptyString(producer.id)
    ) {
      throw new Error(`${label}.producer plugin, service, and id must be non-empty strings`);
    }
    return;
  }
  throw new Error(`${label}.producer.origin must be core or plugin`);
}

/** Validate the shared schema identity emitted by both Probe and Detector boundaries. */
export function validateEvidenceSchemaMeta(value: EvidenceSchemaMeta, label: string): void {
  if (!value || typeof value !== "object") throw new Error(`${label} must be an Evidence record`);
  if (!isNonEmptyString(value.kind)) {
    throw new Error(`${label}.kind must be a non-empty string`);
  }
  if (!Number.isInteger(value.schemaVersion) || value.schemaVersion < 1) {
    throw new Error(`${label}.schemaVersion must be a positive integer`);
  }
  validateProducer(value.producer, label);
}
