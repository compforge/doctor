import type { HealthProvider } from "../extensions";
import type { HealthActions, HealthProviderResult } from "../flow";

/** @spec Infrastructure checks precede service startup checks and retain their own execution locations. */
export async function runInfrastructureChecks(provider: HealthProvider, result: HealthProviderResult,
  actions: Pick<HealthActions, "databases" | "dataSources" | "s3" | "signal" | "stopped">, checkpoint: () => void): Promise<void> {
  if (!actions.signal?.aborted && !actions.stopped?.() && provider.databaseSources?.length && actions.databases) {
    result.databases = await actions.databases(provider, checks => { result.databases = checks; checkpoint(); });
    checkpoint();
  }
  if (!actions.signal?.aborted && !actions.stopped?.() && provider.dataSources?.length && actions.dataSources) {
    result.dataSources = await actions.dataSources(provider);
    checkpoint();
  }
  if (!actions.signal?.aborted && !actions.stopped?.() && provider.s3Sources?.length && actions.s3) {
    result.s3 = await actions.s3(provider, checks => { result.s3 = checks; checkpoint(); });
    checkpoint();
  }
}
