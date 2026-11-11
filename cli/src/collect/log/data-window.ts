import { COLLECT_WINDOW_KIND, validateCollectWindow, type CollectWindow } from "@compforge/doctor-plugin";
import type { DataOutput, DataFacts } from "../data/model";

export interface DataLogWindow {
  bizId: string;
  service: string;
  queryId: string;
  factIndex: number;
  window: CollectWindow;
}

export interface DataWindowRejection {
  bizId: string;
  service: string;
  queryId: string;
  factIndex: number;
  reason: string;
}

export interface DataLogWindows {
  windows: readonly DataLogWindow[];
  rejected: readonly DataWindowRejection[];
}

/**
 * @spec Only windows for the input ID itself can constrain its log request; relations do not transfer windows.
 * @why Data projections include related records whose lifetimes may be much broader than the selected activity.
 */
export function dataLogWindows(output: DataOutput | undefined): DataLogWindows {
  return factsLogWindows((output?.items ?? []).map(item => ({ bizId: item.bizId, facts: item.diagnosis?.evidence.facts })));
}

export function factsLogWindows(items: readonly { bizId: string; facts?: DataFacts }[]): DataLogWindows {
  const windows: DataLogWindow[] = [], rejected: DataWindowRejection[] = [];
  for (const item of items) {
    for (const query of item.facts?.capabilityResults ?? []) {
      if (query.status !== "collected") continue;
      query.result.facts.forEach((fact, factIndex) => {
        if (fact.kind !== COLLECT_WINDOW_KIND) return;
        const source = { bizId: item.bizId, service: query.service, queryId: query.id, factIndex };
        try {
          if (fact.factType !== "record" || fact.schemaVersion !== 1) throw new Error("collect.window requires RecordFact schemaVersion=1");
          const window = validateCollectWindow(fact.record);
          if (window.identity.value !== item.bizId) return;
          windows.push({ ...source, window });
        } catch (error) {
          rejected.push({ ...source, reason: error instanceof Error ? error.message : String(error) });
        }
      });
    }
  }
  return { windows, rejected };
}
