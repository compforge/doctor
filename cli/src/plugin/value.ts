import { serializeValue, deserializeValue, type JsonValue, type Summary, type Value } from "@compforge/harness-common";
import { type ObservationDefinition } from "@compforge/doctor-plugin";

/** Adapt the generic Value contract to a persisted workload Observation. */
export function encodeObservationValue(definition: ObservationDefinition, value: Value, label: string): { value: JsonValue; summary: Summary } {
  const saved = serializeValue(value, definition.codec, { label, maxBytes: 1024 * 1024 });
  return { value: saved.data, summary: saved.summary };
}

export interface StoredValueObservation {
  service: string;
  probe: string;
  observationKind: string;
  observationSchemaVersion: number;
  value: JsonValue;
  summary: Summary;
}

export type RestoredObservationValue =
  | { status: "decoded"; value: Value; summary: Summary }
  | { status: "unavailable"; reason: string; summary: Summary };

/** Restore a caller-selected data contract without consulting active Probe registrations or replacing saved presentation. */
export function restoreObservationValue(observation: StoredValueObservation, definition?: ObservationDefinition): RestoredObservationValue {
  const unavailable = (reason: string): RestoredObservationValue => ({ status: "unavailable", reason, summary: observation.summary });
  if (!definition || definition.kind !== observation.observationKind || definition.schemaVersion !== observation.observationSchemaVersion) {
    return unavailable("未提供匹配的 Codec；原始数据和已保存摘要仍可读取");
  }
  try {
    return { status: "decoded", value: deserializeValue(observation.value, definition.codec), summary: observation.summary };
  } catch {
    return unavailable("Codec 解码失败；原始数据和已保存摘要仍可读取");
  }
}
