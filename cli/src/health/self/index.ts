import type { HealthProvider } from "../extensions";
import type { HealthActions, HealthProviderResult } from "../flow";

export async function runSelfChecks(provider: HealthProvider, result: HealthProviderResult,
  actions: Pick<HealthActions, "probes">, checkpoint: () => void): Promise<void> {
  const probes = provider.probes?.filter(probe => probe.health === "self");
  if (!probes?.length || !actions.probes) return;
  result.probes = [...(result.probes ?? []), ...await actions.probes({ ...provider, probes })];
  checkpoint();
}
