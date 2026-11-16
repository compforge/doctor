import type { HealthProvider } from "../extensions";
import type { HealthActions, HealthProviderResult } from "../flow";

export async function runDependencyChecks(provider: HealthProvider, result: HealthProviderResult,
  actions: Pick<HealthActions, "probes" | "endpoints" | "signal" | "stopped">, checkpoint: () => void): Promise<void> {
  const probes = provider.probes?.filter(probe => probe.health === "deps");
  if ((probes?.length || provider.endpointProbes?.length) && actions.probes) {
    result.probes = [...(result.probes ?? []), ...await actions.probes({ ...provider, probes }, "deps")];
    checkpoint();
  }
  if (!actions.signal?.aborted && !actions.stopped?.() && provider.endpoints !== undefined && actions.endpoints) {
    result.endpoints = await actions.endpoints(provider);
    checkpoint();
  }
}
