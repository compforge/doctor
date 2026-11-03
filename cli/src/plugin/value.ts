import { validateSummary, type JsonObject, type ObservationDefinition, type ServiceCatalog, type Summary, type Value } from "@compforge/doctor-plugin";
import { immutableJsonObject } from "./observation";
import { workloadProbeProviders } from "./workload-extensions";

function valueSummary(value: Value, label: string): Summary {
  if (!value || typeof value.summary !== "function") throw new Error(`${label}: Codec must restore a Value with summary()`);
  const summary = value.summary();
  validateSummary(summary);
  return immutableJsonObject(summary, `${label}.summary`) as unknown as Summary;
}

/** @spec Only encoded JSON crosses the persisted Evidence boundary; decode validates producer output. */
export function encodeObservationValue(definition: ObservationDefinition, value: Value, label: string): { value: JsonObject; summary: Summary } {
  const json = immutableJsonObject(definition.codec.encode(value), `${label}.value`);
  const restored = definition.codec.decode(json);
  return { value: json, summary: valueSummary(restored, label) };
}

export interface StoredValueObservation {
  service: string;
  probe: string;
  observationKind: string;
  observationSchemaVersion: number;
  value: JsonObject;
  summary: Summary;
}

export type RestoredObservationValue =
  | { status: "decoded"; value: Value; summary: Summary }
  | { status: "unavailable"; reason: string; summary: Summary };

export type ObservationValueReader = (observation: StoredValueObservation) => RestoredObservationValue;

/**
 * @spec Offline decoding selects the exact Service/producer/kind/version contract without fetching a Plugin
 * @rule Missing or invalid codecs preserve the saved JSON and Summary for generic archive reading
 */
export function restoreObservationValue(observation: StoredValueObservation, catalog?: ServiceCatalog): RestoredObservationValue {
  const label = `${observation.service}/${observation.probe}/${observation.observationKind}@${observation.observationSchemaVersion}`;
  if (!catalog) return { status: "unavailable", reason: `${label}: 未加载 Plugin Codec，使用已保存摘要`, summary: observation.summary };
  try {
    const definition = workloadProbeProviders(catalog, observation.service)
      .find(({ extension }) => extension.id === observation.probe
        && extension.produces.kind === observation.observationKind
        && extension.produces.schemaVersion === observation.observationSchemaVersion)?.extension.produces;
    if (!definition || !("codec" in definition)) return {
      status: "unavailable", reason: `${label}: 未找到匹配的 Codec，使用已保存摘要`, summary: observation.summary,
    };
    const json = immutableJsonObject(observation.value, `${label}.value`);
    const value = definition.codec.decode(json);
    return { status: "decoded", value, summary: valueSummary(value, label) };
  } catch {
    // Codec exceptions may contain raw configuration values; retain data in its existing evidence location.
    return { status: "unavailable", reason: `${label}: Codec 解码失败，使用已保存摘要`, summary: observation.summary };
  }
}
