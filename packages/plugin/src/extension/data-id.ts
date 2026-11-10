import type { Extension, RegisteredExtension } from "./index";
import type { ServiceInspectQuery, ServiceInspectQueryOutcome } from "../service";

export const DATA_ID_KIND = "data.id";
export type DataIdInput = readonly ServiceInspectQuery[];
export type DataIdOutput = readonly ServiceInspectQueryOutcome[];

/**
 * Identity matching and Fact declarations belong to this kind, not the generic Extension protocol.
 *
 * @see {@link ../../../../cli/docs/commands/data.md#identity-关系驱动跨-service-采集}
 */
export interface DataIdExtension extends Extension<DataIdInput, DataIdOutput> {
  readonly kind: typeof DATA_ID_KIND;
  readonly accepts: readonly string[];
  readonly provides: readonly string[];
  readonly expands?: readonly string[];
  readonly limitations?: readonly string[];
  readonly dataSource?: string;
}

/** Validate domain metadata at consumption; an open kind string alone is not type proof. */
export function requireDataIdExtension(extension: RegisteredExtension): DataIdExtension {
  if (extension.kind !== DATA_ID_KIND) throw new Error(`Expected ${DATA_ID_KIND}, got ${extension.kind}`);
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
  return extension as DataIdExtension;
}
