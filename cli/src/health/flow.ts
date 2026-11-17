import { HEALTH_SCOPES, healthCheckScope, type HealthCheckExtension, type HealthScope, type HealthProbeResult, type HealthCheckQuery } from "@compforge/doctor-plugin";
import { diagnosticMessage } from "../command/diagnostic";
import type { HealthProvider } from "./extensions";
import type { CaseCheckResult } from "./cases/run";

export interface HealthCheckResult {
  id: string; scope: HealthScope; description: string;
  status: HealthProbeResult["status"] | "skipped" | "not-run" | "cancelled";
  startedAt?: string; finishedAt?: string; summary: string;
  reusedFrom?: { service: string; check: string };
  dataSourceId?: string;
  evidence?: HealthProbeResult["evidence"]; cases?: CaseCheckResult[];
}
export interface HealthResult { checkedAt: string; query: HealthCheckQuery; providers: {
  name: string; namespace: string; unsupported?: string; checks: HealthCheckResult[];
}[] }
export interface HealthActions {
  signal: AbortSignal; stopped(): boolean;
  selectBusinessProviders(providers: readonly HealthProvider[]): Promise<readonly HealthProvider[] | undefined>;
  run(provider: HealthProvider, check: HealthCheckExtension, checkpoint: (result: Partial<HealthCheckResult>) => void): Promise<Partial<HealthCheckResult>>;
  show(result: HealthResult): void;
}
/** @spec Run one scope across all Services before the next; stopping preserves completed evidence and every unstarted declaration. */
export async function runHealthSession(providers: readonly HealthProvider[], query: HealthCheckQuery, actions: HealthActions): Promise<HealthResult> {
  const result: HealthResult = { checkedAt: new Date().toISOString(), query, providers: providers.map(provider => ({
    name: provider.name, namespace: provider.namespace, unsupported: provider.unsupported,
    checks: provider.checks.map(check => ({ id: check.id, scope: healthCheckScope(check), description: check.description,
      status: "not-run", summary: "尚未执行" })),
  })) };
  const stop = () => {
    for (const provider of result.providers) for (const check of provider.checks) if (check.status === "not-run") {
      check.summary = actions.signal.aborted ? "执行前已取消" : "用户结束巡检，未执行该检查";
    }
    actions.show(result); return result;
  };
  actions.show(result);
  for (const scope of HEALTH_SCOPES) {
    if (actions.signal.aborted || actions.stopped()) return stop();
    let selected = providers.filter(provider => provider.checks.some(check => healthCheckScope(check) === scope));
    if (!selected.length) continue;
    if (scope === "biz") {
      let selection: readonly HealthProvider[] | undefined;
      try { selection = await actions.selectBusinessProviders(selected); }
      catch (error) { if (actions.signal.aborted || actions.stopped()) return stop(); throw error; }
      if (!selection?.length || actions.signal.aborted || actions.stopped()) return stop();
      for (const [index, provider] of providers.entries()) if (!selection.includes(provider)) {
        for (const check of result.providers[index]!.checks) if (check.scope === "biz") Object.assign(check, { status: "skipped", summary: "用户未选择该 Service 的业务检查" });
      }
      selected = [...selection];
    }
    for (const [index, provider] of providers.entries()) {
      if (!selected.includes(provider)) continue;
      for (const [checkIndex, extension] of provider.checks.entries()) {
        if (healthCheckScope(extension) !== scope) continue;
        if (actions.signal.aborted || actions.stopped()) return stop();
        const check = result.providers[index]!.checks[checkIndex]!;
        const save = (update: Partial<HealthCheckResult>) => { Object.assign(check, update); actions.show(result); };
        check.startedAt = new Date().toISOString();
        try { save(await actions.run(provider, extension, save)); }
        catch (error) { save({ status: actions.signal.aborted ? "cancelled" : "unavailable", summary: diagnosticMessage(error) }); }
        check.finishedAt = new Date().toISOString(); actions.show(result);
      }
    }
  }
  return result;
}
