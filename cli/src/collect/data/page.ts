import { collectedFact, failedFact } from "../protocol";
import { serializeDataPage, dataPageOutput, type DataPage } from "@compforge/doctor-plugin";
import { CommandStatus } from "../../command";
import { invokeExtension } from "../../plugin/extension";
import type { Inspect } from "../inspection";
import type { DataCommandContext } from "./context";
import type { DataFacts, DataTypeFact, DataTypeResult } from "./model";
import type { DataAccessPreparation } from "./preparation";
import { MAX_DATA_FACT_BYTES } from "./capability/collect";

/** @spec Service × biz-type owns pagination and failure; one failed source cannot erase another page. */
export function makeDataPageInspect(access: DataAccessPreparation): Inspect<DataFacts, DataCommandContext> {
  return { id: "data-type-queries", run: async ctx => {
    const typeResults: DataTypeResult[] = [];
    const providers = ctx.listProviders ?? [];
    const maxBytes = Math.floor(MAX_DATA_FACT_BYTES / Math.max(1, providers.length));
    for (const provider of providers) {
      const { name: service, extension } = provider;
      const identity = { service, extension: extension.id, bizType: extension.bizType };
      const prepared = access.lists.get(JSON.stringify([service, extension.id]));
      const pagination = ctx.config.list!;
      ctx.log(`[data] ${service}/${extension.bizType} page=${pagination.page} pageSize=${pagination.pageSize}${ctx.config.tenantId ? ` tenant=${ctx.config.tenantId}` : ""}`);
      let result: DataTypeResult;
      try {
        ctx.command.signal.throwIfAborted();
        if (!prepared?.context || prepared.access.status !== "collected") {
          throw new Error(prepared?.access.status !== "collected" ? prepared?.access.reason ?? "Data access unavailable" : "Data context unavailable");
        }
        const query = { ...(ctx.config.tenantId ? { tenantId: ctx.config.tenantId } : {}), page: pagination.page, pageSize: pagination.pageSize, maxBytes };
        const output = await invokeExtension(extension, prepared.context, query);
        const data = serializeDataPage(dataPageOutput(output.data, query), extension.codec, maxBytes);
        result = { ...identity, status: data.truncated ? CommandStatus.Partial : CommandStatus.Ok, data };
        ctx.log(`[data] ${service}/${extension.bizType}: ${data.items.length} items, total=${data.total}${data.truncated ? `; ${data.truncated.reason}` : ""}`);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        result = { ...identity, status: ctx.command.signal.aborted ? CommandStatus.Cancelled : CommandStatus.Failed, reason };
        ctx.log(`[data] ${service}/${extension.bizType}: ${result.status}: ${reason}`);
      }
      typeResults.push(result);
      ctx.bundle.addStep({ id: `data-page-${typeResults.length}`, title: `${service} / ${extension.bizType}`, risk: "observe",
        status: result.status === CommandStatus.Cancelled ? "failed" : result.status,
        reason: "reason" in result ? result.reason : result.data.truncated?.reason });
    }
    return { typeResults: typeResults.map(dataTypeFact) };
  } };
}

export function dataTypeFact(result: DataTypeResult): DataTypeFact {
  const identity = { service: result.service, extension: result.extension, bizType: result.bizType };
  return "data" in result
    ? { ...collectedFact("data.type-result", "data-type-queries", { data: result.data }), ...identity }
    : { ...failedFact("data.type-result", "data-type-queries", result.reason), ...identity,
      ...(result.status === CommandStatus.Cancelled ? { cancelled: true } : {}) };
}

export function dataTypeResult(fact: DataTypeFact): DataTypeResult {
  const identity = { service: fact.service, extension: fact.extension, bizType: fact.bizType };
  return fact.status === "collected"
    ? { ...identity, status: fact.data.truncated ? CommandStatus.Partial : CommandStatus.Ok, data: fact.data }
    : { ...identity, status: fact.cancelled ? CommandStatus.Cancelled : CommandStatus.Failed, reason: fact.reason };
}

export function dataPageSummary(results: readonly DataTypeResult[]): string {
  return results.map(result => {
    const title = `${result.service} / ${result.bizType}: ${result.status}`;
    if (!("data" in result)) return `- ${title}: ${result.reason}`;
    const { page, pageSize, total, items, truncated } = result.data;
    return `- ${title}; page=${page}, pageSize=${pageSize}, total=${total}, returned=${items.length}${truncated ? `; ${truncated.reason}` : ""}\n`
      + items.map(item => `  - ${JSON.stringify(item)}`).join("\n");
  }).join("\n");
}
