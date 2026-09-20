import type { Extension, RegisteredExtension } from "./index";
import type { ServiceInspect, ServiceInspectQuery, ServiceInspectQueryOutcome } from "../service";

export const FACTS_INSPECT_KIND = "facts.inspect";
export type FactsInspectInput = readonly ServiceInspectQuery[];
export type FactsInspectOutput = readonly ServiceInspectQueryOutcome[];

/** Identity matching and Fact declarations belong to this kind, not the generic Extension protocol. */
export interface FactsInspectExtension extends Extension<FactsInspectInput, FactsInspectOutput> {
  readonly kind: typeof FACTS_INSPECT_KIND;
  readonly accepts: readonly string[];
  readonly provides: readonly string[];
  readonly expands?: readonly string[];
  readonly limitations?: readonly string[];
  readonly dataSource?: string;
}

/** Validate domain metadata at consumption; an open kind string alone is not type proof. */
export function requireFactsInspectExtension(extension: RegisteredExtension): FactsInspectExtension {
  if (extension.kind !== FACTS_INSPECT_KIND) throw new Error(`Expected ${FACTS_INSPECT_KIND}, got ${extension.kind}`);
  const item = extension as unknown as Record<string, unknown>;
  for (const field of ["accepts", "provides", "expands", "limitations"] as const) {
    const values = item[field];
    if (values === undefined && (field === "expands" || field === "limitations")) continue;
    if (!Array.isArray(values) || values.some(value => typeof value !== "string" || !value.trim())
      || new Set(values).size !== values.length || (field !== "expands" && field !== "limitations" && !values.length)) {
      throw new Error(`${extension.id}.${field} must contain unique non-empty strings`);
    }
  }
  if (item.dataSource !== undefined && typeof item.dataSource !== "string") throw new Error(`${extension.id}.dataSource must be a string`);
  return extension as FactsInspectExtension;
}

/** One declaration remains the source of truth while other consumers still use ServiceInspect. */
export function adaptServiceInspect(inspect: ServiceInspect): FactsInspectExtension {
  return {
    id: "inspect", kind: FACTS_INSPECT_KIND, access: inspect.access,
    description: inspect.description, accepts: inspect.accepts, provides: inspect.provides,
    expands: inspect.expands, limitations: inspect.limitations, dataSource: inspect.dataSource,
    run: (context, queries) => inspect.inspect(context, queries),
  };
}
