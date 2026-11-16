import { runSelfChecks } from "./self";
import { runDependencyChecks } from "./deps";
import { runBusinessChecks } from "./biz";
import type { S3HealthCheck } from "./s3/probe";
import type { CaseCheckResult } from "./biz/run";
import type { HealthScope } from "./scopes";
import type { HealthProvider } from "./extensions";
import { useLogger } from "../terminal/log";

import type { DataSourceHealthEvidence } from "../datasource/health/report";

export interface HealthDataSourceCheck {
  service: string;
  dataSource: string;
  evidence?: DataSourceHealthEvidence;
  error?: string;
  status?: "skipped" | "not-run";
  reason?: string;
}

export interface HealthProviderResult {
  namespace: string;
  name: string;
  unsupported?: string;
  probes?: import("./probe-runner").HealthProbeCheck[];
  cases?: CaseCheckResult[];
  casesError?: string;
  casesSkipped?: string;
  s3?: S3HealthCheck[];
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
  stopped?(): boolean;
  selectBusinessProviders?(providers: readonly HealthProvider[], result: HealthResult): Promise<readonly HealthProvider[] | undefined>;
  enterScope?(scope: HealthScope, result: HealthResult, providers: readonly HealthProvider[]): Promise<boolean>;
  leaveScope?(scope: HealthScope, result: HealthResult): void;
  cases(provider: HealthProvider, query: HealthQuery, checkpoint: (results: CaseCheckResult[]) => void): Promise<CaseCheckResult[]>;
  probes?(provider: HealthProvider, scope: "self" | "deps"): Promise<import("./probe-runner").HealthProbeCheck[]>;
  dataSources?(provider: HealthProvider): Promise<HealthDataSourceCheck[]>;
  s3?(provider: HealthProvider, checkpoint: (checks: S3HealthCheck[]) => void): Promise<S3HealthCheck[]>;
  endpoints?(provider: HealthProvider): Promise<import("./deps/endpoints").HealthEndpointCheck[]>;
  show(result: HealthResult): void;
}

/**
 * @spec Health completes each scope across all selected Services before entering the next.
 * @spec Business Service selection happens after earlier scopes and before Case identity preparation.
 * @spec Stopping records unstarted Probes and declared Endpoints without executing their access operations.
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
      || (scope === "deps" && (provider.s3Sources?.length || provider.dataSources?.length || provider.endpointProbes?.length || provider.endpoints !== undefined))
      || (scope === "business" && provider.consumers.length)));
  const stop = (remaining: HealthScope[]) => {
    result.notRunScopes = remaining;
    const reason = actions.signal?.aborted ? "执行前已取消" : actions.stopped?.() ? "用户结束巡检" : "未继续执行该层级";
    for (const [index, provider] of providers.entries()) {
      const summary = result.providers[index]!;
      for (const probe of [...provider.probes ?? [], ...(provider.endpointProbes ?? []).map(probe => ({ id: probe.id, health: "deps" as const }))]) {
        if (!probe.health || !scopes.includes(probe.health)) continue;
        if (summary.probes?.some(check => check.probe === probe.id && check.scope === probe.health)) continue;
        (summary.probes ??= []).push({ probe: probe.id, scope: probe.health, status: "not-run",
          reason, observations: [], findings: [] });
      }
      if (scopes.includes("deps") && provider.s3Sources?.length) {
        for (const source of provider.s3Sources) {
          if (summary.s3?.some(check => check.service === source.service && check.dataSource === source.dataSource)) continue;
          const shared = result.providers.flatMap(provider => provider.s3 ?? []).find(check =>
            check.service === source.service && check.dataSource === source.dataSource);
          (summary.s3 ??= []).push(shared ?? { ...source, executionLocation: "doctor-host", channel: "direct",
            startedAt: new Date().toISOString(), status: "not-run", reason, steps: [] });
        }
      }
      if (scopes.includes("business") && provider.consumers.length && !summary.cases && !summary.casesError) {
        summary.casesSkipped ??= reason;
      }
      if (scopes.includes("deps") && provider.dataSources?.length) {
        for (const source of provider.dataSources) {
          if (summary.dataSources?.some(check => check.service === source.service && check.dataSource === source.dataSource)) continue;
          (summary.dataSources ??= []).push({ ...source, status: "not-run", reason });
        }
      }
      if (scopes.includes("deps") && provider.endpoints?.length && summary.endpoints === undefined) {
        summary.endpoints = provider.endpoints.map(endpoint => ({
          source: endpoint.id ?? `${endpoint.host}:${endpoint.port}`, workload: endpoint.workload?.name,
          endpoint, status: "not-run", reason,
        }));
        useLogger("health").info(`${provider.name}: ${summary.endpoints.length} 个 Endpoint 未执行 · ${reason}`);
      }
    }
    actions.show(result);
    return result;
  };
  for (const [scopeIndex, scope] of scopes.entries()) {
    let entered = !actions.signal?.aborted && !actions.stopped?.();
    let scopeProviders = providers;
    if (entered && scope === "business" && actions.selectBusinessProviders) {
      let selected: readonly HealthProvider[] | undefined;
      try { selected = await actions.selectBusinessProviders(providers, result); }
      catch (error) {
        if (!actions.signal?.aborted) throw error;
      }
      if (!selected?.length || actions.signal?.aborted) return stop(scopes.slice(scopeIndex));
      scopeProviders = selected;
      for (const [index, provider] of providers.entries()) {
        if (provider.consumers.length && !selected.includes(provider)) result.providers[index]!.casesSkipped = "用户未选择该 Service 的业务检查";
      }
      actions.show(result);
    }
    if (entered && actions.enterScope) {
      try { entered = await actions.enterScope(scope, result, scopeProviders); }
      catch (error) {
        if (!actions.signal?.aborted) throw error;
        entered = false;
      }
    }
    if (!entered || actions.signal?.aborted || actions.stopped?.()) {
      return stop(scopes.slice(scopeIndex));
    }
    for (const [index, provider] of providers.entries()) {
      if (actions.signal?.aborted || actions.stopped?.()) {
        return stop(scopes.slice(scopeIndex + 1));
      }
      if (!scopeProviders.includes(provider)) continue;
      const summary = result.providers[index]!;
      const checkpoint = () => actions.show(result);
      if (scope === "self") await runSelfChecks(provider, summary, actions, checkpoint);
      else if (scope === "deps") await runDependencyChecks(provider, summary, actions, checkpoint);
      else await runBusinessChecks(provider, summary, query, actions, checkpoint);
    }
    if (actions.signal?.aborted || actions.stopped?.()) return stop(scopes.slice(scopeIndex + 1));
    actions.leaveScope?.(scope, result);
  }
  return result;
}
