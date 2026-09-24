import type { Extension, RegisteredExtension } from "./index";
import type { ServicePerfScenario } from "../service";

export const PERF_SCENARIOS_KIND = "perf.scenarios";

/** The consumer selects a preset and owns dispatch, budgets and observation windows. */
export interface PerfScenariosExtension extends Extension<void, readonly ServicePerfScenario[]> {
  readonly kind: typeof PERF_SCENARIOS_KIND;
}

export function requirePerfScenariosExtension(extension: RegisteredExtension): PerfScenariosExtension {
  if (extension.kind !== PERF_SCENARIOS_KIND) throw new Error(`Expected ${PERF_SCENARIOS_KIND}, got ${extension.kind}`);
  return extension as PerfScenariosExtension;
}

export function perfScenariosOutput(value: unknown): readonly ServicePerfScenario[] {
  if (!Array.isArray(value) || !value.length) throw new Error("perf.scenarios must return a non-empty scenario list");
  const scenarios = value as ServicePerfScenario[];
  const ids = new Set<string>();
  const text = (item: unknown): item is string => typeof item === "string" && Boolean(item.trim());
  for (const scenario of scenarios) {
    if (!scenario || ![scenario.id, scenario.title, scenario.description, scenario.caseSetId].every(text)
      || ids.has(scenario.id) || (scenario.cases !== undefined && (!Array.isArray(scenario.cases) || !scenario.cases.length))) {
      throw new Error("perf.scenarios returned an invalid or duplicate scenario");
    }
    ids.add(scenario.id);
    const cases = new Set<string>();
    let positiveWeight = false;
    for (const selection of scenario.cases ?? []) {
      if (!selection || !text(selection.caseId) || cases.has(selection.caseId)) {
        throw new Error(`perf.scenarios '${scenario.id}' has an invalid or duplicate Case selection`);
      }
      cases.add(selection.caseId);
      const weight = selection.weight ?? 1;
      if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0) {
        throw new Error(`perf.scenarios '${scenario.id}' has an invalid Case weight`);
      }
      positiveWeight ||= weight > 0;
    }
    if (scenario.cases && !positiveWeight) throw new Error(`perf.scenarios '${scenario.id}' requires a positive Case weight`);
    const observations = scenario.observability;
    if (!observations || [observations.metricServices, observations.logServices, observations.correlationKeys]
      .some(items => !Array.isArray(items) || !items.length || !items.every(text))) {
      throw new Error(`perf.scenarios '${scenario.id}' has invalid observability references`);
    }
  }
  return scenarios;
}
