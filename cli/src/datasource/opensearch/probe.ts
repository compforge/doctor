import type { VdbObservation } from "./model";
export interface OpenSearchHealthProbe {
  id: string;
  outcome: string;
  path: string;
  query?: Record<string, unknown>;
  project?(raw: unknown): unknown;
  parse(raw: unknown): VdbObservation;
}
