import type { CaseCheckResult } from "./cases";
import type { HealthProvider } from "./extensions";

import type { DataSourceHealthEvidence } from "../datasource/health/report";

export interface HealthDataSourceCheck {
  service: string;
  dataSource: string;
  evidence?: DataSourceHealthEvidence;
  error?: string;
}

export interface HealthProviderResult {
  namespace: string;
  name: string;
  unsupported?: string;
  probes?: import("./probes").HealthProbeCheck[];
  cases?: CaseCheckResult[];
  casesError?: string;
  dataSources?: HealthDataSourceCheck[];
}

/** Basic probes and Cases have no historical statistics window. */
export interface HealthQuery { tenantId?: string }

export interface HealthResult {
  checkedAt?: string;
  query: HealthQuery;
  providers: HealthProviderResult[];
}

export interface HealthActions {
  signal?: AbortSignal;
  cases(provider: HealthProvider, query: HealthQuery, checkpoint: (results: CaseCheckResult[]) => void): Promise<CaseCheckResult[]>;
  probes?(provider: HealthProvider): Promise<import("./probes").HealthProbeCheck[]>;
  dataSources?(provider: HealthProvider): Promise<HealthDataSourceCheck[]>;
  show(result: HealthResult): void;
}

/** @spec Health runs current Probe, DataSource and Case checks; historical statistics belong to Overview. */
export async function runHealthSession(
  providers: readonly HealthProvider[], query: HealthQuery, actions: HealthActions,
): Promise<HealthResult> {
  const result: HealthResult = { checkedAt: new Date().toISOString(), query,
    providers: providers.map(provider => ({ namespace: provider.namespace, name: provider.name, unsupported: provider.unsupported })) };
  actions.show(result);
  for (const [index, provider] of providers.entries()) {
    if (actions.signal?.aborted) return result;
    const summary = result.providers[index]!;
    if (provider.probes?.length && actions.probes) {
      summary.probes = await actions.probes(provider);
      actions.show(result);
    }
    if (provider.dataSources?.length && actions.dataSources) {
      summary.dataSources = await actions.dataSources(provider);
      actions.show(result);
    }
    if (!provider.consumers.length) continue;
    try {
      summary.cases = await actions.cases(provider, query, cases => { summary.cases = cases; actions.show(result); });
    } catch (error) { summary.casesError = error instanceof Error ? error.message : String(error); }
    // Keep completed and interrupted attempts deliverable on cancellation.
    actions.show(result);
  }
  return result;
}
