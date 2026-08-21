import type {
  Identity,
  ServiceInspectCapability,
  ServiceInspectFact,
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

/**
 * Validate runtime values crossing the Plugin boundary before Commands retain them as Facts.
 *
 * @spec One Inspect Query returns independently consumable Facts whose kinds are declared by provides
 * @see {@link ../../docs/kernel.md}
 */
export function normalizeServiceInspectFacts(input: {
  value: unknown;
  service: string;
  queryIdentity: Identity;
  capability: ServiceInspectCapability;
}): readonly ServiceInspectFact[] {
  const { value, service, queryIdentity, capability } = input;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${service} inspect query must return a non-empty Fact array`);
  }

  const kinds = new Set<string>();
  return value.map((item, index) => {
    const label = `${service} inspect fact[${index}]`;
    const fact = record(item, label);
    const kind = nonEmptyString(fact.kind, `${label}.kind`);
    if (!capability.provides.includes(kind)) {
      throw new Error(
        `${label}.kind '${kind}' is not declared by provides=[${capability.provides.join(", ")}]`,
      );
    }
    if (kinds.has(kind)) {
      throw new Error(`${service} inspect query returned duplicate Fact kind '${kind}'`);
    }
    kinds.add(kind);
    if (fact.service !== service) {
      throw new Error(`${label}.service must equal '${service}'`);
    }

    const resolution = record(fact.resolution, `${label}.resolution`);
    if (resolution.inputId !== queryIdentity.value) {
      throw new Error(`${label}.resolution.inputId must equal the Query identity value`);
    }
    nonEmptyString(resolution.resolvedAs, `${label}.resolution.resolvedAs`);

    if (fact.missingEvidence !== undefined) {
      if (!Array.isArray(fact.missingEvidence)) {
        throw new Error(`${label}.missingEvidence must be an array`);
      }
      fact.missingEvidence.forEach((reason, reasonIndex) => {
        nonEmptyString(reason, `${label}.missingEvidence[${reasonIndex}]`);
      });
    }

    if (fact.relations !== undefined) {
      if (!Array.isArray(fact.relations)) throw new Error(`${label}.relations must be an array`);
      fact.relations.forEach((item, relationIndex) => {
        const relationLabel = `${label}.relations[${relationIndex}]`;
        const relation = record(item, relationLabel);
        nonEmptyString(relation.kind, `${relationLabel}.kind`);
        const from = identity(relation.from, `${relationLabel}.from`);
        if (!sameIdentity(from, queryIdentity)) {
          throw new Error(`${relationLabel}.from must equal the Query identity`);
        }
        const to = identity(relation.to, `${relationLabel}.to`);
        if (!(capability.expands ?? []).includes(to.kind)) {
          throw new Error(
            `${relationLabel}.to.kind '${to.kind}' is not declared by expands=[${(capability.expands ?? []).join(", ")}]`,
          );
        }
      });
    }
    return item as ServiceInspectFact;
  });
}
