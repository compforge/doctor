import type { HealthProvider } from "../extensions";
import type { HealthActions, HealthProviderResult, HealthQuery } from "../flow";

export async function runBusinessChecks(provider: HealthProvider, result: HealthProviderResult,
  query: HealthQuery, actions: Pick<HealthActions, "cases" | "signal">, checkpoint: () => void): Promise<void> {
  if (!provider.consumers.length || actions.signal?.aborted) return;
  try {
    result.cases = await actions.cases(provider, query, cases => { result.cases = cases; checkpoint(); });
  } catch (error) { result.casesError = error instanceof Error ? error.message : String(error); }
  // Keep completed and interrupted attempts deliverable on cancellation.
  checkpoint();
}
