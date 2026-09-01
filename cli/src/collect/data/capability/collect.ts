import type {
  Identity,
  RelationFact,
  ServiceCatalog,
  ServiceDefinition,
  ServiceInspectBudget,
  ServiceInspectResult,
  ServiceWithContribution,
} from "@compforge/doctor-plugin";
import { normalizeServiceInspectResult } from "../../../plugin/inspect";
import type { Inspect } from "../../inspection";
import { collectedFact, failedFact, unavailableFact } from "../../protocol";
import type { DataCommandContext } from "../context";
import type {
  CollectedDataInspectResult,
  DataConfig,
  DataFacts,
  DataInspectionFacts,
  DataInspectResult,
  DataServiceSelection,
} from "../model";

type DataStage = DataInspectResult["stage"];

export const MAX_DATA_RELATION_DEPTH = 8;
export const MAX_DATA_IDENTITIES = 1_000;
export const MAX_DATA_FACTS = 5_000;
export const MAX_DATA_FACT_BYTES = 32 * 1024 * 1024;

interface RemainingFactBudget {
  facts: number;
  bytes: number;
}

function dataOutcomeId(stage: DataStage, service: string): string {
  return `data-${stage}-${service}`;
}

function identityKey(identity: Identity): string {
  return `${identity.kind}\0${identity.value}`;
}

function isCollected(result: DataInspectResult): result is CollectedDataInspectResult {
  return result.status === "collected";
}

function completedResults(
  results: readonly DataInspectResult[],
): ReadonlyMap<string, readonly ServiceInspectResult[]> {
  const completed = new Map<string, ServiceInspectResult[]>();
  for (const result of results) {
    if (!isCollected(result)) continue;
    const serviceResults = completed.get(result.service) ?? [];
    serviceResults.push(result.result);
    completed.set(result.service, serviceResults);
  }
  return completed;
}

function relationTargets(result: CollectedDataInspectResult): readonly Identity[] {
  return result.result.facts.flatMap((fact) => (
    fact.factType === "relation" ? [(fact as RelationFact).to] : []
  ));
}

function dataServiceUnavailable(service: string, facts: DataInspectionFacts): string | undefined {
  const target = facts.services[service]?.target;
  if (!target) return `未选择 ${service}`;
  if (target.status !== "collected") return target.reason;
  const capability = facts.services[service]?.inspect;
  if (capability?.status !== "collected") return capability?.reason ?? `${service} 数据不可查询`;
  return undefined;
}

function resultId(stage: DataStage, service: string, identity: Identity): string {
  return `data-query:${stage}:${service}:${identity.kind}:${identity.value}`;
}

function inspectBudget(remaining: RemainingFactBudget): ServiceInspectBudget | undefined {
  if (remaining.facts < 1 || remaining.bytes < 1) return undefined;
  return { maxFacts: remaining.facts, maxBytes: remaining.bytes };
}

function consumeBudget(remaining: RemainingFactBudget, result: ServiceInspectResult): void {
  remaining.facts -= result.facts.length;
  remaining.bytes -= result.facts.reduce((total, fact) => (
    total + Buffer.byteLength(JSON.stringify(fact), "utf8")
  ), 0);
}

async function queryIdentity(input: {
  declared: ServiceWithContribution<ServiceDefinition, "inspect">;
  stage: DataStage;
  identity: Identity;
  ctx: DataCommandContext;
  results: ReadonlyMap<string, readonly ServiceInspectResult[]>;
  remaining: RemainingFactBudget;
}): Promise<DataInspectResult> {
  const { declared, stage, identity, ctx, results, remaining } = input;
  const id = resultId(stage, declared.name, identity);
  const budget = inspectBudget(remaining);
  if (!budget) {
    return Object.assign(unavailableFact(
      "data.inspect-result",
      "data-service-contributions",
      `Data Fact 总预算已耗尽（maxFacts=${MAX_DATA_FACTS}, maxBytes=${MAX_DATA_FACT_BYTES}）`,
    ), {
      id,
      stage,
      service: declared.name,
      identity,
    });
  }
  const pluginContext = ctx.pluginContexts[declared.name];
  if (!pluginContext) throw new Error(`Service '${declared.name}' Inspect contribution 缺少 PluginContext`);
  try {
    const capability = declared.contributions.inspect;
    const result = normalizeServiceInspectResult({
      value: await capability.inspect(pluginContext, { identity, results, budget }),
      service: declared.name,
      queryIdentity: identity,
      capability,
      budget,
    });
    consumeBudget(remaining, result);
    return Object.assign(collectedFact(
      "data.inspect-result",
      "data-service-contributions",
      { result },
    ), {
      id,
      stage,
      service: declared.name,
      identity,
    });
  } catch (error) {
    return Object.assign(failedFact(
      "data.inspect-result",
      "data-service-contributions",
      error instanceof Error ? error.message : String(error),
    ), {
      id,
      stage,
      service: declared.name,
      identity,
    });
  }
}

function recordStage(
  ctx: DataCommandContext,
  stage: DataStage,
  service: string,
  results: readonly DataInspectResult[],
  reused: readonly CollectedDataInspectResult[] = [],
): void {
  const collected = results.filter(isCollected);
  const incomplete = results.filter((result) => result.status !== "collected");
  const hasEvidence = collected.length > 0 || reused.length > 0;
  const status = !results.length && !reused.length
    ? "unavailable"
    : !incomplete.length
    ? "ok"
    : hasEvidence
    ? "partial"
    : incomplete.some((result) => result.status === "failed")
    ? "failed"
    : "unavailable";
  const reason = !results.length && !reused.length
    ? `${service} 没有接受本轮已知 Identity`
    : incomplete.length
    ? `${stage === "expand" ? "扩展" : "查询"} ${service} ${hasEvidence ? "部分" : ""}业务数据未取得：`
      + incomplete.map((result) => (
        `${result.identity.kind}:${result.identity.value}: ${result.reason}`
      )).join("；")
    : undefined;
  ctx.bundle.fill(dataOutcomeId(stage, service), {
    status,
    reason,
    output: `${JSON.stringify({ reused, results }, null, 2)}\n`,
    ext: "json",
  });
}

interface QueuedIdentity {
  identity: Identity;
  depth: number;
}

/**
 * Expand Relations to a bounded identity closure, independent of Service Catalog order.
 *
 * @spec Data Relation expansion uses a deduplicated work queue with explicit depth, identity, Fact count, and Fact byte budgets
 * @see {@link ../../../../docs/kernel.md}
 */
async function collectExpansionResults(input: {
  expanders: readonly ServiceWithContribution<ServiceDefinition, "inspect">[];
  inspectionFacts: DataInspectionFacts;
  config: DataConfig;
  ctx: DataCommandContext;
  remaining: RemainingFactBudget;
}): Promise<{ results: DataInspectResult[]; identities: Identity[] }> {
  const { expanders, inspectionFacts, config, ctx, remaining } = input;
  if (config.ids.length > MAX_DATA_IDENTITIES) {
    throw new Error(`初始业务 Identity 数量超过上限 ${MAX_DATA_IDENTITIES}`);
  }
  const queue: QueuedIdentity[] = config.ids.map((value) => ({
    identity: { kind: "biz_id", value },
    depth: 0,
  }));
  const known = new Set(queue.map(({ identity }) => identityKey(identity)));
  const queried = new Set<string>();
  const results: DataInspectResult[] = [];
  const activeExpanders = expanders.filter((declared) => {
    const unavailable = dataServiceUnavailable(declared.name, inspectionFacts);
    if (unavailable) {
      ctx.bundle.fill(dataOutcomeId("expand", declared.name), { status: "unavailable", reason: unavailable });
      return false;
    }
    return true;
  });

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]!;
    for (const declared of activeExpanders) {
      if (!declared.contributions.inspect.accepts.includes(current.identity.kind)) continue;
      const queryKey = `${declared.name}\0${identityKey(current.identity)}`;
      if (queried.has(queryKey)) continue;
      queried.add(queryKey);
      const queryResult = await queryIdentity({
        declared,
        stage: "expand",
        identity: current.identity,
        ctx,
        results: completedResults(results),
        remaining,
      });
      results.push(queryResult);
      if (!isCollected(queryResult)) continue;
      for (const target of relationTargets(queryResult)) {
        const key = identityKey(target);
        if (known.has(key)) continue;
        if (current.depth >= MAX_DATA_RELATION_DEPTH) {
          throw new Error(`Data Relation 扩展深度超过上限 ${MAX_DATA_RELATION_DEPTH}`);
        }
        if (known.size >= MAX_DATA_IDENTITIES) {
          throw new Error(`Data Relation Identity 数量超过上限 ${MAX_DATA_IDENTITIES}`);
        }
        known.add(key);
        queue.push({ identity: target, depth: current.depth + 1 });
      }
    }
  }

  for (const declared of activeExpanders) {
    recordStage(ctx, "expand", declared.name, results.filter((result) => result.service === declared.name));
  }
  return { results, identities: queue.map(({ identity }) => identity) };
}

/**
 * Run selected Service Inspect contributions and retain query-level results that may feed later Probes.
 * Command owns traversal and budgets; contribution implementations only answer one Query at a time.
 */
export async function collectDataInspectResults(input: {
  selections: readonly DataServiceSelection[];
  catalog: ServiceCatalog;
  inspectionFacts: DataInspectionFacts;
  config: DataConfig;
  ctx: DataCommandContext;
}): Promise<readonly DataInspectResult[]> {
  const { selections, catalog, inspectionFacts, config, ctx } = input;
  const collected: DataInspectResult[] = [];
  const remaining = { facts: MAX_DATA_FACTS, bytes: MAX_DATA_FACT_BYTES };
  const declaredServices = selections.map(({ service }) => {
    const declared = catalog.findWithContribution(service, "inspect");
    if (!declared) throw new Error(`Doctor 未注册 Service '${service}' 的 Inspect contribution`);
    return declared;
  });
  const expansion = await collectExpansionResults({
    expanders: declaredServices.filter(({ contributions }) => !!contributions.inspect.expands?.length),
    inspectionFacts,
    config,
    ctx,
    remaining,
  });
  collected.push(...expansion.results);
  const expansionResults = [...expansion.results];
  const completedExpansionResults = completedResults(expansionResults);
  for (const declared of declaredServices) {
    const service = declared.name;
    const unavailable = dataServiceUnavailable(declared.name, inspectionFacts);
    if (unavailable) {
      ctx.bundle.fill(dataOutcomeId("provide", service), { status: "unavailable", reason: unavailable });
      continue;
    }
    const reusable = expansionResults.filter((result): result is CollectedDataInspectResult => (
      isCollected(result) && result.service === service
    ));
    const reusedIdentities = new Set(reusable.map((result) => identityKey(result.identity)));
    const results: DataInspectResult[] = [];
    for (const identity of expansion.identities.filter((identity) => (
      declared.contributions.inspect.accepts.includes(identity.kind)
      && !reusedIdentities.has(identityKey(identity))
    ))) {
      results.push(await queryIdentity({
        declared,
        stage: "provide",
        identity,
        ctx,
        results: completedExpansionResults,
        remaining,
      }));
    }
    collected.push(...results);
    recordStage(ctx, "provide", service, results, reusable);
  }

  return collected;
}

/** Adapt the selected Plugin Service Inspect contributions into Core's Inspect phase. */
export function makeDataContributionInspect(input: {
  selections: readonly DataServiceSelection[];
  catalog: ServiceCatalog;
  config: DataConfig;
}): Inspect<DataFacts, DataCommandContext> {
  return {
    id: "data-service-contributions",
    dependsOn: ["data-service-targets"],
    run: async (ctx, facts) => {
      if (!facts.services) {
        throw new Error("data-service-contributions requires data-service-targets Facts");
      }
      const capabilityResults = await collectDataInspectResults({
        ...input,
        inspectionFacts: { services: facts.services },
        ctx,
      });
      return { capabilityResults };
    },
  };
}
