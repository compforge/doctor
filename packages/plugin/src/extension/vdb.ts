import type { Extension, RegisteredExtension } from "./index";
import type { ServiceVdbTarget } from "../datasource";

export const VDB_TARGET_INSPECT_KIND = "datasource.vdb.inspect";

/** Resolve connection configuration for a named Service data source. */
export interface VdbTargetInspectExtension extends Extension<void, ServiceVdbTarget> {
  readonly kind: typeof VDB_TARGET_INSPECT_KIND;
  readonly dataSource: string;
}

export function requireVdbTargetInspectExtension(extension: RegisteredExtension): VdbTargetInspectExtension {
  if (extension.kind !== VDB_TARGET_INSPECT_KIND) throw new Error(`Expected ${VDB_TARGET_INSPECT_KIND}, got ${extension.kind}`);
  const inspect = extension as VdbTargetInspectExtension;
  if (typeof inspect.dataSource !== "string" || !inspect.dataSource.trim()) throw new Error(`${extension.id}: dataSource must be a non-empty ID`);
  return inspect;
}

/** Errors identify fields without disclosing endpoints or credentials. */
export function vdbTargetOutput(value: unknown): ServiceVdbTarget {
  const target = value as ServiceVdbTarget | undefined;
  if (!target || [target.backend, target.store, target.configurationKind].some(item => typeof item !== "string" || !item.trim())) {
    throw new Error("datasource.vdb.inspect returned an invalid target identity");
  }
  for (const field of ["endpoint", "username", "password", "configPath"] as const) {
    if (target[field] !== undefined && typeof target[field] !== "string") throw new Error(`datasource.vdb.inspect returned an invalid ${field}`);
  }
  if (target.source !== undefined) {
    if (!target.source || typeof target.source !== "object" || Array.isArray(target.source)
      || ["namespace", "pod", "container", "path"].some(field => {
        const item = (target.source as Record<string, unknown>)[field];
        return item !== undefined && typeof item !== "string";
      })) throw new Error("datasource.vdb.inspect returned invalid source provenance");
  }
  return target;
}
