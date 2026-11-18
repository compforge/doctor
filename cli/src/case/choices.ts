import type { Case } from "@compforge/spec-case/model";
import type { DoctorCaseSet } from "./catalog";

export interface CaseChoice { source: DoctorCaseSet; item: Case }

export function caseRef({source, item}: CaseChoice): string {
  // A local file and a Plugin source named "local" may contribute the same CaseSet.
  const owner = source.source === "local" ? "@local" : encodeURIComponent(source.sourceId ?? "plugin");
  return [owner, encodeURIComponent(source.caseSet.caseset), item.id].join("/");
}

/** Resolve CLI IDs within the caller's eligible Cases, preserving selection order. */
export function resolveCaseChoices(choices: readonly CaseChoice[], ids: readonly string[]): CaseChoice[] {
  const byId = new Map<string, CaseChoice | null>();
  for (const choice of choices) {
    for (const key of [choice.item.id, caseRef(choice)]) {
      byId.set(key, byId.has(key) ? null : choice);
    }
  }
  const selected = new Set<CaseChoice>();
  for (const id of ids) {
    const choice = byId.get(id);
    if (choice === undefined) throw new Error(`候选列表不包含 Case：${id}`);
    if (choice === null) throw new Error(`Case '${id}' 重名，请使用 source/caseset/case`);
    selected.add(choice);
  }
  return [...selected];
}
