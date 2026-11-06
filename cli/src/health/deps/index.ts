import type { ServiceDependencyRuntime } from "../../collect/shared/service-dependency";
import type { DataSourceHealthSession } from "../../datasource/health/session";
import type { HealthProvider } from "../extensions";
import type { HealthActions, HealthDataSourceCheck, HealthProviderResult } from "../flow";

export async function runDependencyChecks(provider: HealthProvider, result: HealthProviderResult,
  actions: Pick<HealthActions, "probes" | "dataSources" | "endpoints" | "signal">, checkpoint: () => void): Promise<void> {
  const probes = provider.probes?.filter(probe => probe.health === "deps");
  if ((probes?.length || provider.endpointProbes?.length) && actions.probes) {
    result.probes = [...(result.probes ?? []), ...await actions.probes({ ...provider, probes }, "deps")];
    checkpoint();
  }
  if (!actions.signal?.aborted && provider.endpoints !== undefined && actions.endpoints) {
    result.endpoints = await actions.endpoints(provider);
    checkpoint();
  }
  if (!actions.signal?.aborted && provider.dataSources?.length && actions.dataSources) {
    result.dataSources = await actions.dataSources(provider);
    checkpoint();
  }
}

export async function checkHealthDataSources(provider: HealthProvider, sources: ServiceDependencyRuntime,
  session: DataSourceHealthSession, signal: AbortSignal): Promise<HealthDataSourceCheck[]> {
  const results: HealthDataSourceCheck[] = [];
  for (const reference of provider.dataSources ?? []) {
    if (signal.aborted) break;
    try {
      const prepared = await sources.prepareDataSource(reference.service, reference.dataSource);
      const health = await session.probe(prepared.search, signal);
      results.push({ ...reference, evidence: { target: { ...prepared.evidenceTarget, ...reference }, health } });
    } catch (error) {
      results.push({ ...reference, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}
