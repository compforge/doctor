import type {
  Identity,
  ServiceCatalog,
  ServiceInspectFact,
  ServiceDefinition,
  ServiceWithCapability,
} from "@compforge/doctor-plugin";
import { normalizeServiceInspectFacts } from "../../../plugin/inspect";
import type { DataCommandContext } from "../context";
import type {
  CollectedDataInspectFact,
  DataInspectFact,
  DataConfig,
  DataInspectionFacts,
  DataServiceSelection,
} from "../model";

type DataStage = DataInspectFact["stage"];

export const MAX_DATA_RELATION_DEPTH = 8;
export const MAX_DATA_IDENTITIES = 1_000;

function dataOutcomeId(stage: DataStage, service: string): string {
  return `data-${stage}-${service}`;
}

function identityKey(identity: Identity): string {
  return `${identity.kind}\0${identity.value}`;
}

function isCollected(fact: DataInspectFact): fact is CollectedDataInspectFact {
  return fact.status === "collected";
}

function completedResults(
  facts: readonly DataInspectFact[],
): ReadonlyMap<string, readonly ServiceInspectFact[]> {
  const results = new Map<string, ServiceInspectFact[]>();
  for (const fact of facts) {
    if (!isCollected(fact)) continue;
    const serviceResults = results.get(fact.service) ?? [];
    serviceResults.push(fact.fact);
    results.set(fact.service, serviceResults);
  }
  return results;
}

function relationTargets(fact: CollectedDataInspectFact): readonly Identity[] {
  return fact.fact.relations?.map((relation) => relation.to) ?? [];
}

function dataServiceUnavailable(service: string, facts: DataInspectionFacts): string | undefined {
  const target = facts.services[service]?.target;
  if (!target) return `未选择 ${service}`;
  if (target.status !== "collected") return target.reason;
  const capability = facts.services[service]?.inspect;
  if (capability?.status !== "collected") return capability?.reason ?? `${service} 数据不可查询`;
  return undefined;
}

function factId(stage: DataStage, service: string, identity: Identity, kind?: string): string {
  const suffix = kind ? `:${kind}` : "";
  return `data-fact:${stage}:${service}:${identity.kind}:${identity.value}${suffix}`;
}

async function queryIdentity(input: {
  declared: ServiceWithCapability<ServiceDefinition, "inspect">;
  stage: DataStage;
  identity: Identity;
  ctx: DataCommandContext;
  results: ReadonlyMap<string, readonly ServiceInspectFact[]>;
}): Promise<DataInspectFact[]> {
  const { declared, stage, identity, ctx, results } = input;
  const pluginContext = ctx.pluginContexts[declared.name];
  if (!pluginContext) throw new Error(`Service '${declared.name}' Inspect Capability 缺少 PluginContext`);
  try {
    const capability = declared.capabilities.inspect;
    const serviceFacts = normalizeServiceInspectFacts({
      value: await capability.query(pluginContext, { identity, results }),
      service: declared.name,
      queryIdentity: identity,
      capability,
    });
    return serviceFacts.map((fact) => ({
      id: factId(stage, declared.name, identity, fact.kind),
      status: "collected",
      stage,
      service: declared.name,
      identity,
      fact,
      summary: capability.summarize(fact),
    }));
  } catch (error) {
    return [{
      id: factId(stage, declared.name, identity),
      status: "failed",
      stage,
      service: declared.name,
      identity,
      reason: error instanceof Error ? error.message : String(error),
    }];
  }
}

function recordStage(
  ctx: DataCommandContext,
  stage: DataStage,
  service: string,
  facts: readonly DataInspectFact[],
  reused: readonly CollectedDataInspectFact[] = [],
): void {
  const collected = facts.filter(isCollected);
  const failures = facts.filter((fact) => fact.status === "failed");
  const hasEvidence = collected.length > 0 || reused.length > 0;
  const status = !facts.length && !reused.length
    ? "unavailable"
    : !failures.length
    ? "ok"
    : hasEvidence
    ? "partial"
    : "failed";
  const reason = !facts.length && !reused.length
    ? `${service} 没有接受本轮已知 Identity`
    : failures.length
    ? `${stage === "expand" ? "扩展" : "查询"} ${service} ${hasEvidence ? "部分" : ""}业务数据失败：`
      + failures.map((fact) => fact.status === "failed"
        ? `${fact.identity.kind}:${fact.identity.value}: ${fact.reason}`
        : "").join("；")
    : undefined;
  ctx.bundle.fill(dataOutcomeId(stage, service), {
    status,
    reason,
    output: `${JSON.stringify({ reused, facts }, null, 2)}\n`,
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
 * @spec Data Relation expansion uses a deduplicated work queue with explicit depth and identity budgets
 * @see {@link ../../../../docs/kernel.md}
 */
async function collectExpansionFacts(input: {
  expanders: readonly ServiceWithCapability<ServiceDefinition, "inspect">[];
  inspectionFacts: DataInspectionFacts;
  config: DataConfig;
  ctx: DataCommandContext;
}): Promise<{ facts: DataInspectFact[]; identities: Identity[] }> {
  const { expanders, inspectionFacts, config, ctx } = input;
  if (config.ids.length > MAX_DATA_IDENTITIES) {
    throw new Error(`初始业务 Identity 数量超过上限 ${MAX_DATA_IDENTITIES}`);
  }
  const queue: QueuedIdentity[] = config.ids.map((value) => ({
    identity: { kind: "biz_id", value },
    depth: 0,
  }));
  const known = new Set(queue.map(({ identity }) => identityKey(identity)));
  const queried = new Set<string>();
  const facts: DataInspectFact[] = [];
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
      if (!declared.capabilities.inspect.accepts.includes(current.identity.kind)) continue;
      const queryKey = `${declared.name}\0${identityKey(current.identity)}`;
      if (queried.has(queryKey)) continue;
      queried.add(queryKey);
      const queryFacts = await queryIdentity({
        declared,
        stage: "expand",
        identity: current.identity,
        ctx,
        results: completedResults(facts),
      });
      facts.push(...queryFacts);
      for (const fact of queryFacts) {
        if (!isCollected(fact)) continue;
        for (const target of relationTargets(fact)) {
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
  }

  for (const declared of activeExpanders) {
    recordStage(ctx, "expand", declared.name, facts.filter((fact) => fact.service === declared.name));
  }
  return { facts, identities: queue.map(({ identity }) => identity) };
}

/**
 * Run the Service capabilities selected by doctor data and retain their outputs as Facts, including Relations.
 * Command owns traversal and ordering; capability implementations only answer one Query at a time.
 */
export async function collectDataInspectFacts(input: {
  selections: readonly DataServiceSelection[];
  catalog: ServiceCatalog;
  inspectionFacts: DataInspectionFacts;
  config: DataConfig;
  ctx: DataCommandContext;
}): Promise<readonly DataInspectFact[]> {
  const { selections, catalog, inspectionFacts, config, ctx } = input;
  const collected: DataInspectFact[] = [];
  const declaredServices = selections.map(({ service }) => {
    const declared = catalog.findWith(service, "inspect");
    if (!declared) throw new Error(`Doctor 未注册 Service '${service}' 的 Inspect Capability`);
    return declared;
  });
  const expansion = await collectExpansionFacts({
    expanders: declaredServices.filter(({ capabilities }) => !!capabilities.inspect.expands?.length),
    inspectionFacts,
    config,
    ctx,
  });
  collected.push(...expansion.facts);
  const expansionFacts = [...expansion.facts];
  const expansionResults = completedResults(expansionFacts);
  for (const declared of declaredServices) {
    const service = declared.name;
    const unavailable = dataServiceUnavailable(declared.name, inspectionFacts);
    if (unavailable) {
      ctx.bundle.fill(dataOutcomeId("provide", service), { status: "unavailable", reason: unavailable });
      continue;
    }
    const reusable = expansionFacts.filter((fact): fact is CollectedDataInspectFact => (
      isCollected(fact) && fact.service === service
    ));
    const reusedIdentities = new Set(reusable.map((fact) => identityKey(fact.identity)));
    const facts: DataInspectFact[] = [];
    for (const identity of expansion.identities.filter((identity) => (
      declared.capabilities.inspect.accepts.includes(identity.kind)
      && !reusedIdentities.has(identityKey(identity))
    ))) {
      facts.push(...await queryIdentity({
        declared,
        stage: "provide",
        identity,
        ctx,
        results: expansionResults,
      }));
    }
    collected.push(...facts);
    recordStage(ctx, "provide", service, facts, reusable);
  }

  return collected;
}
