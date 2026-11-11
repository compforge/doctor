import { createHash } from "node:crypto";
import type { DataIdExtension, PluginContext, ServiceInspectQuery, ServiceInspectQueryOutcome } from "@compforge/doctor-plugin";
import { defineExecutionRecord } from "../../../command/context";
import { inspectExtensionQueries, normalizeServiceInspectResult } from "../../../plugin/inspect";
import { boundInspectSources, normalizeInspectSources } from "../../../plugin/inspect-sources";
import type { DataCommandContext } from "../context";
import type { DataConfig } from "../model";

export type IdentityQueryContext = Pick<DataCommandContext, "command" | "log"> & {
  config: Pick<DataConfig, "kube" | "profileName" | "fallbackIdentity" | "tenantId">;
};

const queries = defineExecutionRecord<Promise<ServiceInspectQueryOutcome>>("data.identity-query");

/**
 * @link cli/docs/commands/data.md
 * @spec Equivalent identity queries share a bounded outcome within one root command, including failures.
 * @why Target, constraints and upstream evidence define equivalence; retained partial evidence is never retried implicitly.
 * @why Cached outcomes remain bounded snapshots. Each consumer reapplies its own budget without losing truncation or failures.
 */
export async function queryDataIdentities(ctx: IdentityQueryContext, service: string, extension: DataIdExtension,
  context: PluginContext, input: readonly ServiceInspectQuery[]): Promise<readonly ServiceInspectQueryOutcome[]> {
  const pending: { query: ServiceInspectQuery; resolve: (value: ServiceInspectQueryOutcome) => void }[] = [];
  const results = input.map(query => {
    const scope = [JSON.stringify([ctx.command.pluginIdentity, ctx.config.kube, ctx.config.profileName,
      ctx.config.fallbackIdentity, ctx.config.tenantId, service, extension.id, query.identity, query.constraints]),
      createHash("sha256").update(JSON.stringify([...query.results])).digest("hex")];
    const cached = ctx.command.latestRecord(queries, scope);
    if (cached) { ctx.log(`[collect:data] 复用 ${service} ${query.identity.kind}:${query.identity.value} 查询结果`); return cached; }
    let resolve!: (value: ServiceInspectQueryOutcome) => void;
    const promise = new Promise<ServiceInspectQueryOutcome>(done => { resolve = done; });
    ctx.command.record(queries, scope, promise);
    pending.push({ query, resolve });
    return promise;
  });
  if (pending.length) {
    const outcomes = await inspectExtensionQueries(extension, context, pending.map(item => item.query));
    pending.forEach(({ query, resolve }, index) => {
      const outcome = outcomes[index]!;
      try {
        if (outcome.status === "failed") {
          const bounded = boundInspectSources(normalizeInspectSources(outcome.sources, service), query.budget);
          resolve({ ...outcome, sources: bounded.sources,
            reason: outcome.reason + (bounded.omitted ? `; ${bounded.omitted} source outcomes omitted by budget` : "") });
          return;
        }
        resolve({ ...outcome, result: normalizeServiceInspectResult({
          value: outcome.result, service, queryIdentity: query.identity, capability: extension, budget: query.budget,
        }) });
      } catch (error) {
        resolve({ identity: query.identity, status: "failed", reason: error instanceof Error ? error.message : String(error) });
      }
    });
  }
  return Promise.all(results);
}
