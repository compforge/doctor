import { runSelfChecks } from "./self";
import { runDependencyChecks } from "./deps";
import { runBusinessChecks } from "./biz";
import type { CaseCheckResult } from "./biz/run";
import type { HealthScope } from "./scopes";
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
  probes?: import("./probe-runner").HealthProbeCheck[];
  cases?: CaseCheckResult[];
  casesError?: string;
  dataSources?: HealthDataSourceCheck[];
}

/** Basic probes and Cases have no historical statistics window. */
export interface HealthQuery { tenantId?: string }

export interface HealthResult {
  checkedAt?: string;
  query: HealthQuery;
  notRunScopes?: HealthScope[];
  providers: HealthProviderResult[];
}

export interface HealthActions {
  signal?: AbortSignal;
  scopes?: readonly HealthScope[];
  enterScope?(scope: HealthScope, result: HealthResult): Promise<boolean>;
  leaveScope?(scope: HealthScope, result: HealthResult): void;
  cases(provider: HealthProvider, query: HealthQuery, checkpoint: (results: CaseCheckResult[]) => void): Promise<CaseCheckResult[]>;
  probes?(provider: HealthProvider, scope: "self" | "deps"): Promise<import("./probe-runner").HealthProbeCheck[]>;
  dataSources?(provider: HealthProvider): Promise<HealthDataSourceCheck[]>;
  show(result: HealthResult): void;
}

/**
 * @spec Health completes each scope across all selected Services before entering the next.
 * @spec Refusing the next scope retains completed evidence and never prepares its Cases or identities.
 * @see {@link component://docs/commands/health.md}
 */
export async function runHealthSession(
  providers: readonly HealthProvider[], query: HealthQuery, actions: HealthActions,
): Promise<HealthResult> {
  const result: HealthResult = { checkedAt: new Date().toISOString(), query,
    providers: providers.map(provider => ({ namespace: provider.namespace, name: provider.name, unsupported: provider.unsupported })) };
  actions.show(result);
  const scopes = (["self", "deps", "business"] as const).filter(scope =>
    (!actions.scopes || actions.scopes.includes(scope)) && providers.some(provider =>
      provider.probes?.some(probe => probe.health === scope)
      || (scope === "deps" && provider.dataSources?.length)
      || (scope === "business" && provider.consumers.length)));
  for (const [scopeIndex, scope] of scopes.entries()) {
    let entered = !actions.signal?.aborted;
    if (entered && actions.enterScope) {
      try { entered = await actions.enterScope(scope, result); }
      catch (error) {
        if (!actions.signal?.aborted) throw error;
        entered = false;
      }
    }
    if (!entered || actions.signal?.aborted) {
      result.notRunScopes = scopes.slice(scopeIndex);
      actions.show(result);
      return result;
    }
    for (const [index, provider] of providers.entries()) {
      if (actions.signal?.aborted) {
        result.notRunScopes = scopes.slice(scopeIndex);
        actions.show(result);
        return result;
      }
      const summary = result.providers[index]!;
      const checkpoint = () => actions.show(result);
      if (scope === "self") await runSelfChecks(provider, summary, actions, checkpoint);
      else if (scope === "deps") await runDependencyChecks(provider, summary, actions, checkpoint);
      else await runBusinessChecks(provider, summary, query, actions, checkpoint);
    }
    if (!actions.signal?.aborted) actions.leaveScope?.(scope, result);
  }
  return result;
}
