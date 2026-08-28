import type {
  Fact,
  Identity,
  RelationFact,
  ServiceInspectBudget,
  ServiceInspectCapability,
  ServiceInspectResult,
} from "@compforge/doctor-plugin";

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

function identity(value: unknown, label: string): Identity {
  const candidate = record(value, label);
  return {
    kind: nonEmptyString(candidate.kind, `${label}.kind`),
    value: nonEmptyString(candidate.value, `${label}.value`),
  };
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.kind === right.kind && left.value === right.value;
}

function validateRelation(input: {
  fact: Record<string, unknown>;
  label: string;
  queryIdentity: Identity;
  capability: ServiceInspectCapability;
}): RelationFact {
  const { fact, label, queryIdentity, capability } = input;
  const from = identity(fact.from, `${label}.from`);
  if (!sameIdentity(from, queryIdentity)) {
    throw new Error(`${label}.from must equal the Query identity`);
  }
  const to = identity(fact.to, `${label}.to`);
  if (!(capability.expands ?? []).includes(to.kind)) {
    throw new Error(
      `${label}.to.kind '${to.kind}' is not declared by expands=[${(capability.expands ?? []).join(", ")}]`,
    );
  }
  return fact as unknown as RelationFact;
}

function validateFact(input: {
  item: unknown;
  index: number;
  service: string;
  queryIdentity: Identity;
  capability: ServiceInspectCapability;
  valueKinds: Set<string>;
  recordKeys: Set<string>;
  relationKeys: Set<string>;
}): Fact {
  const { item, index, service, queryIdentity, capability } = input;
  const label = `${service} inspect result.facts[${index}]`;
  const fact = record(item, label);
  const kind = nonEmptyString(fact.kind, `${label}.kind`);
  const factType = nonEmptyString(fact.factType, `${label}.factType`);

  if (factType === "relation") {
    const relation = validateRelation({ fact, label, queryIdentity, capability });
    const key = `${kind}\0${relation.from.kind}\0${relation.from.value}\0${relation.to.kind}\0${relation.to.value}`;
    if (input.relationKeys.has(key)) throw new Error(`${label} duplicates RelationFact '${kind}'`);
    input.relationKeys.add(key);
    return relation;
  }

  if (!capability.provides.includes(kind)) {
    throw new Error(
      `${label}.kind '${kind}' is not declared by provides=[${capability.provides.join(", ")}]`,
    );
  }
  if (factType === "value") {
    if (!("value" in fact)) throw new Error(`${label}.value is required`);
    if (input.valueKinds.has(kind)) {
      throw new Error(`${service} inspect result returned duplicate ValueFact kind '${kind}'`);
    }
    input.valueKinds.add(kind);
    return fact as unknown as Fact;
  }
  if (factType === "record") {
    const recordKey = nonEmptyString(fact.recordKey, `${label}.recordKey`);
    if (!("record" in fact)) throw new Error(`${label}.record is required`);
    const key = `${kind}\0${recordKey}`;
    if (input.recordKeys.has(key)) {
      throw new Error(`${service} inspect result returned duplicate RecordFact '${kind}:${recordKey}'`);
    }
    input.recordKeys.add(key);
    return fact as unknown as Fact;
  }
  throw new Error(`${label}.factType must be 'value', 'record', or 'relation'`);
}

function factBytes(fact: Fact, label: string): number {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(fact);
  } catch (error) {
    throw new Error(`${label} must be JSON serializable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (serialized === undefined) throw new Error(`${label} must be JSON serializable`);
  return Buffer.byteLength(serialized, "utf8");
}

function applyBudget(
  facts: readonly Fact[],
  budget: ServiceInspectBudget,
): { facts: readonly Fact[]; omittedFacts: number } {
  const kept: Fact[] = [];
  let bytes = 0;
  for (const [index, fact] of facts.entries()) {
    const size = factBytes(fact, `inspect result.facts[${index}]`);
    if (kept.length >= budget.maxFacts || bytes + size > budget.maxBytes) break;
    kept.push(fact);
    bytes += size;
  }
  return { facts: kept, omittedFacts: facts.length - kept.length };
}

/**
 * Validate and bound one query-level result before Commands retain it as stable Facts.
 *
 * @spec Inspect returns ValueFact, RecordFact, or RelationFact inside a query-level result; ValueFact kinds and RecordFact keys are unique
 * @spec Core enforces the caller-owned Fact count and serialized-byte budget before Evidence composition
 * @see {@link ../../docs/kernel.md}
 */
export function normalizeServiceInspectResult(input: {
  value: unknown;
  service: string;
  queryIdentity: Identity;
  capability: ServiceInspectCapability;
  budget: ServiceInspectBudget;
}): ServiceInspectResult {
  const { service, queryIdentity, capability, budget } = input;
  if (!Number.isInteger(budget.maxFacts) || budget.maxFacts < 1) {
    throw new Error(`${service} inspect budget.maxFacts must be a positive integer`);
  }
  if (!Number.isInteger(budget.maxBytes) || budget.maxBytes < 1) {
    throw new Error(`${service} inspect budget.maxBytes must be a positive integer`);
  }

  const result = record(input.value, `${service} inspect result`);
  const resolution = record(result.resolution, `${service} inspect result.resolution`);
  if (resolution.inputId !== queryIdentity.value) {
    throw new Error(`${service} inspect result.resolution.inputId must equal the Query identity value`);
  }
  const identifiers = record(resolution.identifiers, `${service} inspect result.resolution.identifiers`);
  for (const [name, value] of Object.entries(identifiers)) {
    if (value !== undefined && typeof value !== "string") {
      throw new Error(`${service} inspect result.resolution.identifiers.${name} must be a string or undefined`);
    }
  }
  if (!Array.isArray(result.facts)) throw new Error(`${service} inspect result.facts must be an array`);

  const valueKinds = new Set<string>();
  const recordKeys = new Set<string>();
  const relationKeys = new Set<string>();
  const facts = result.facts.map((item, index) => validateFact({
    item,
    index,
    service,
    queryIdentity,
    capability,
    valueKinds,
    recordKeys,
    relationKeys,
  }));

  const missingEvidence = result.missingEvidence;
  if (missingEvidence !== undefined) {
    if (!Array.isArray(missingEvidence)) {
      throw new Error(`${service} inspect result.missingEvidence must be an array`);
    }
    missingEvidence.forEach((reason, index) => {
      nonEmptyString(reason, `${service} inspect result.missingEvidence[${index}]`);
    });
  }
  const providerTruncation = result.truncated === undefined
    ? undefined
    : record(result.truncated, `${service} inspect result.truncated`);
  if (providerTruncation) {
    nonEmptyString(providerTruncation.reason, `${service} inspect result.truncated.reason`);
    const omittedFacts = providerTruncation.omittedFacts;
    if (omittedFacts !== undefined && (
      typeof omittedFacts !== "number" || !Number.isInteger(omittedFacts) || omittedFacts < 0
    )) {
      throw new Error(`${service} inspect result.truncated.omittedFacts must be a non-negative integer`);
    }
  }

  const bounded = applyBudget(facts, budget);
  const truncationReasons = [
    providerTruncation?.reason,
    bounded.omittedFacts
      ? `Core Fact budget omitted ${bounded.omittedFacts} item(s) (maxFacts=${budget.maxFacts}, maxBytes=${budget.maxBytes})`
      : undefined,
  ].filter((reason): reason is string => !!reason);
  const providerOmitted = typeof providerTruncation?.omittedFacts === "number"
    ? providerTruncation.omittedFacts
    : 0;

  return {
    resolution: {
      inputId: queryIdentity.value,
      resolvedAs: nonEmptyString(resolution.resolvedAs, `${service} inspect result.resolution.resolvedAs`),
      identifiers: identifiers as Readonly<Record<string, string | undefined>>,
    },
    facts: bounded.facts,
    ...(missingEvidence ? { missingEvidence: missingEvidence as string[] } : {}),
    ...(truncationReasons.length ? {
      truncated: {
        reason: truncationReasons.join("; "),
        omittedFacts: providerOmitted + bounded.omittedFacts || undefined,
      },
    } : {}),
  };
}
