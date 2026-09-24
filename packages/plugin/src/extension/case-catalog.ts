import { caseSetFromRaw, validateCaseSet, type CaseSet } from "@compforge/spec-case/model";
import type { ExtensionRegistration } from "./registry";

export const CASE_CATALOG_KIND = "case.catalog";

/** Offline catalog provider. Core and Plugin use the same contract; loading never opens target access. */
export interface CaseCatalogExtension extends ExtensionRegistration {
  readonly kind: typeof CASE_CATALOG_KIND;
  load(): readonly CaseSet[];
}

export function requireCaseCatalogExtension(value: unknown): CaseCatalogExtension {
  const item = value as Partial<CaseCatalogExtension> | undefined;
  if (!item || typeof item.id !== "string" || !item.id.trim()
    || item.kind !== CASE_CATALOG_KIND || typeof item.load !== "function") {
    throw new Error("Invalid case.catalog Extension");
  }
  return item as CaseCatalogExtension;
}

export function loadCaseCatalog(extension: CaseCatalogExtension): readonly CaseSet[] {
  const values = extension.load();
  if (!Array.isArray(values)) throw new Error(`${extension.id}: case.catalog must return CaseSets`);
  const ids = new Set<string>();
  return values.map((value) => {
    const caseSet = caseSetFromRaw(value);
    validateCaseSet(caseSet);
    if (!caseSet.cases.length || ids.has(caseSet.caseset)) {
      throw new Error(`${extension.id}: empty or duplicate CaseSet '${caseSet.caseset}'`);
    }
    ids.add(caseSet.caseset);
    return caseSet;
  });
}
