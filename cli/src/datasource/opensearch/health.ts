import { probeOpenSearchHealth as probe } from "@compforge/harness-toolbox/opensearch/health";
import type { DataSourceHealthInput, DataSourceHealthResult } from "../health/extension";
import { observation } from "./metadata";
export async function probeOpenSearchHealth(input: DataSourceHealthInput): Promise<DataSourceHealthResult> {
  const result = await probe(input);
  return { ...result, observations: result.observations.map(observation),
    probes: result.probes.map(item => ({ ...item, observation: item.observation ? observation(item.observation) : undefined })),
    findings: result.findings.map(item => ({ ...item, schemaVersion: 1, producer: { origin: "core", id: "vdb-health" } })) };
}
