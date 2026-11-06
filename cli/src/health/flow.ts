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
  endpoints?: import("./deps/endpoints").HealthEndpointCheck[];
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
  endpoints?(provider: HealthProvider): Promise<import("./deps/endpoints").HealthEndpointCheck[]>;
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
      || (scope === "deps" && (provider.dataSources?.length || provider.endpointProbes?.length || provider.endpoints !== undefined))
      || (scope === "business" && provider.consumers.length)));
  const stop = (remaining: HealthScope[]) => {
    result.notRunScopes = remaining;
    // @spec Unstarted work is recorded per Probe; a partially executed scope is never called unexecuted.
    for (const [index, provider] of providers.entries()) {
      const summary = result.providers[index]!;
      for (const probe of [...provider.probes ?? [], ...(provider.endpointProbes ?? []).map(probe => ({ id: probe.id, health: "deps" as const }))]) {
        if (!probe.health || !scopes.includes(probe.health)) continue;
        if (summary.probes?.some(check => check.probe === probe.id && check.scope === probe.health)) continue;
        (summary.probes ??= []).push({ probe: probe.id, scope: probe.health, status: "not-run",
          reason: actions.signal?.aborted ? "执行前已取消" : "未继续执行该层级", observations: [], findings: [] });
      }
    }
    actions.show(result);
    return result;
  };
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
      return stop(scopes.slice(scopeIndex));
    }
    for (const [index, provider] of providers.entries()) {
      if (actions.signal?.aborted) {
        return stop(scopes.slice(scopeIndex + 1));
      }
      const summary = result.providers[index]!;
      const checkpoint = () => actions.show(result);
      if (scope === "self") await runSelfChecks(provider, summary, actions, checkpoint);
      else if (scope === "deps") await runDependencyChecks(provider, summary, actions, checkpoint);
      else await runBusinessChecks(provider, summary, query, actions, checkpoint);
    }
    if (actions.signal?.aborted) return stop(scopes.slice(scopeIndex + 1));
    actions.leaveScope?.(scope, result);
  }
  return result;
}
