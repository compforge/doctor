import type { ExtensionRegistration } from "@compforge/doctor-plugin";
import type { SearchEngine } from "@compforge/harness-toolbox/opensearch/types";
import type { VdbFinding, VdbObservation } from "../opensearch/model";

export const DATASOURCE_HEALTH_KIND = "datasource.health";
export interface DataSourceHealthProbeResult {
  id: string;
  status: "ok" | "failed" | "unavailable";
  reason?: string;
  observation?: VdbObservation;
  raw?: unknown;
}
export interface DataSourceHealthResult {
  backend: "opensearch";
  startedAt: string;
  finishedAt: string;
  status: "ok" | "partial" | "unavailable";
  probes: DataSourceHealthProbeResult[];
  observations: VdbObservation[];
  findings: VdbFinding[];
  summary: string;
}
export interface DataSourceHealthInput {
  search: SearchEngine;
  signal?: AbortSignal;
  timeoutMs?: number;
}
/**
 * @spec Core receives an already authorized, prepared client; it never resolves credentials or owns its lifetime.
 * @spec Acquisition completeness is independent of findings: an unhealthy cluster can be successfully probed.
 * @see {@link ../../../docs/extension.md}
 */
export interface DataSourceHealthExtension extends ExtensionRegistration {
  kind: typeof DATASOURCE_HEALTH_KIND;
  backend: "opensearch";
  run(input: DataSourceHealthInput): Promise<DataSourceHealthResult>;
}
