import type { Case, CaseSet } from "@compforge/spec-case/model";
import { caseSetFromRaw, validateCaseSet } from "@compforge/spec-case/model";
import { validateCaseProducer, type CaseProducer } from "./case-producer";
import { validateCaseRunnerFactory, type CaseRunnerFactory } from "./case-runner";

export interface ServiceCaseRef { readonly service: string; readonly source: string }

/**
 * @spec load is offline. Dynamic objects, credentials and sessions belong to execution preparation.
 */
export interface CaseCatalog {
  readonly id: string;
  readonly description?: string;
  load(): readonly CaseSet[];
}

/**
 * Case is a Service-owned resource, alongside DataSource and Workload.
 * @spec The source owns assets and runtime binding; Commands reference it and own selection, scheduling and reporting.
 * @why Producer and runner share the source identity, not separate Extension registrations.
 */
export interface ServiceCaseSource extends CaseCatalog {
  readonly produce?: CaseProducer;
  readonly runner?: CaseRunnerFactory;
}

/** Select the resource's own capability without synthesizing another registration identity. */
export function caseProducer(source: ServiceCaseSource): CaseProducer {
  if (!source.produce) throw new Error(`Case source '${source.id}' does not provide runtime Cases`);
  validateCaseProducer(source.produce);
  return source.produce;
}

export function caseRunner(source: ServiceCaseSource): CaseRunnerFactory {
  if (!source.runner) throw new Error(`Case source '${source.id}' does not provide a runner`);
  validateCaseRunnerFactory(source.runner);
  return source.runner;
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
