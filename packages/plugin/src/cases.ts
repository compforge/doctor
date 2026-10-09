import type { Case, CaseSet } from "@compforge/spec-case/model";
import { caseSetFromRaw, validateCaseSet } from "@compforge/spec-case/model";
import { requireCaseProduceExtension, type CaseProduceExtension } from "./extension/case-produce";
import { requireCaseRunnerCreateExtension, type CaseRunnerCreateExtension } from "./extension/case";

export interface ServiceCaseRef { readonly service: string; readonly source: string }

/**
 * @spec load is offline. Dynamic objects, credentials and sessions belong to execution preparation.
 */
export interface CaseCatalog {
  readonly id: string;
  readonly description?: string;
  load(): readonly CaseSet[];
}

/** @spec A Service contributes Case assets once; commands own selection, scheduling and reporting. */
export interface ServiceCaseSource extends CaseCatalog {
  readonly produce?: Omit<CaseProduceExtension, "id" | "kind" | "namespace">;
  readonly runner?: Omit<CaseRunnerCreateExtension, "id" | "kind" | "namespace">;
}

/** Adapt owned operations to the host invocation seam, never register a second public entry. */
export function caseProducer(source: ServiceCaseSource): CaseProduceExtension {
  if (!source.produce) throw new Error(`Case source '${source.id}' does not provide runtime Cases`);
  return requireCaseProduceExtension({ ...source.produce, id: source.id, kind: "case.produce" });
}

export function caseRunner(source: ServiceCaseSource): CaseRunnerCreateExtension {
  if (!source.runner) throw new Error(`Case source '${source.id}' does not provide a runner`);
  return requireCaseRunnerCreateExtension({ ...source.runner, id: source.id, kind: "case.runner.create" });
}

export function validateCaseSource(source: ServiceCaseSource): void {
  if (!source || typeof source.id !== "string" || !source.id.trim() || typeof source.load !== "function") throw new Error("Invalid Service Case source");
  if (source.produce !== undefined) caseProducer(source);
  if (source.runner !== undefined) caseRunner(source);
}

export function loadCaseCatalog(source: CaseCatalog): readonly CaseSet[] {
  const values = source.load();
  if (!Array.isArray(values)) throw new Error(`${source.id}: Case source must return CaseSets`);
  const ids = new Set<string>();
  return values.map(value => {
    const set = caseSetFromRaw(value);
    validateCaseSet(set);
    if (!set.cases.length || ids.has(set.caseset)) throw new Error(`${source.id}: empty or duplicate CaseSet '${set.caseset}'`);
    ids.add(set.caseset);
    return set;
  });
}

export function validateCaseRef(value: ServiceCaseRef): void {
  if (!value || [value.service, value.source].some(part => typeof part !== "string" || !part.trim())) throw new Error("Case reference requires service and source");
}

/** Compatibility is a protocol property, not a list of command names embedded in the stimulus. */
export type CaseSupport = (item: Case) => boolean;
