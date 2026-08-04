import type { Detector, EvidenceRef } from "../../protocol";
import type { RedisFinding } from "../findings";
import type { RedisEvidence } from "../model";

export type RedisDetector = Detector<RedisEvidence, RedisFinding>;

export function ratio(values: unknown[]): number {
  const positive = values.map(Number).filter((value) => Number.isFinite(value) && value > 0);
  return positive.length > 1 ? Math.max(...positive) / Math.min(...positive) : 1;
}

export function nodeEvidence(host: string, port: number): EvidenceRef {
  return { observationId: `node:${host}:${port}`, role: "supporting" };
}

export function keyspaceEvidence(host: string, port: number, database: number): EvidenceRef {
  return { observationId: `keyspace:${host}:${port}:db${database}`, role: "supporting" };
}

export function pressureEvidence(window: "1s" | "10s", host: string, port: number): EvidenceRef {
  return { observationId: `pressure:${window}:${host}:${port}`, role: "supporting" };
}
