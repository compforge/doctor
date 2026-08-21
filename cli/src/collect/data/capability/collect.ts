import type {
  Identity,
  ServiceCatalog,
  ServiceDataResult,
  ServiceDefinition,
  ServiceWithCapability,
} from "@compforge/doctor-plugin";
import type { DataCommandContext } from "../context";
import type {
  CollectedDataCapabilityFact,
  DataCapabilityFact,
  DataConfig,
  DataInspectionFacts,
  DataServiceSelection,
} from "../model";

type DataStage = DataCapabilityFact["stage"];

function dataOutcomeId(stage: DataStage, service: string): string {
  return `data-${stage}-${service}`;
}

function identityKey(identity: Identity): string {
  return `${identity.kind}\0${identity.value}`;
}

function normalizeIdentity(value: unknown, label: string): Identity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const identity = value as Record<string, unknown>;
  if (typeof identity.kind !== "string" || !identity.kind.trim()) {
    throw new Error(`${label}.kind must be a non-empty string`);
  }
  if (typeof identity.value !== "string" || !identity.value.trim()) {
    throw new Error(`${label}.value must be a non-empty string`);
  }
  return { kind: identity.kind.trim(), value: identity.value.trim() };
}

function isCollected(fact: DataCapabilityFact): fact is CollectedDataCapabilityFact {
  return fact.status === "collected";
}

function completedResults(
  facts: readonly DataCapabilityFact[],
): ReadonlyMap<string, readonly ServiceDataResult[]> {
  const results = new Map<string, ServiceDataResult[]>();
  for (const fact of facts) {
    if (!isCollected(fact)) continue;
    const serviceResults = results.get(fact.service) ?? [];
    serviceResults.push(fact.result);
    results.set(fact.service, serviceResults);
  }
  return results;
}

function relationTargets(
  fact: CollectedDataCapabilityFact,
  catalog: ServiceCatalog,
): Identity[] {
  const declared = catalog.findWith(fact.service, "data");
  const expands = declared?.capabilities.data.expands ?? [];
  if (!expands.length) return [];

  if (fact.result.relations !== undefined) {
    return fact.result.relations.map((relation, index) => {
      const label = `${fact.service} relation[${index}]`;
      if (!relation || typeof relation !== "object") throw new Error(`${label} must be an object`);
      if (typeof relation.kind !== "string" || !relation.kind.trim()) {
        throw new Error(`${label}.kind must be a non-empty string`);
      }
      normalizeIdentity(relation.from, `${label}.from`);
      const target = normalizeIdentity(relation.to, `${label}.to`);
      if (!expands.includes(target.kind)) {
        throw new Error(
          `${label}.to.kind '${target.kind}' is not declared by expands=[${expands.join(", ")}]`,
        );
      }
      return target;
    });
  }
  return [];
}

/**
 * @spec Data query expansion consumes capability Relations; presentation summaries never drive new implementations
 * @see {@link ../../../../docs/kernel.md}
 */
function expandedIdentities(
  config: DataConfig,
  facts: readonly DataCapabilityFact[],
  catalog: ServiceCatalog,
): Identity[] {
  const identities = new Map(
    config.ids.map((value) => {
      const identity = { kind: "biz_id", value };
      return [identityKey(identity), identity] as const;
    }),
  );
  for (const fact of facts) {
    if (!isCollected(fact) || fact.stage !== "expand") continue;
    for (const identity of relationTargets(fact, catalog)) {
      identities.set(identityKey(identity), identity);
    }
  }
  return [...identities.values()];
}

function dataServiceUnavailable(service: string, facts: DataInspectionFacts): string | undefined {
  const target = facts.services[service]?.target;
  if (!target) return `未选择 ${service}`;
  if (target.status !== "collected") return target.reason;
  const capability = facts.services[service]?.capability;
  if (capability?.status !== "collected") return capability?.reason ?? `${service} 数据不可查询`;
  return undefined;
}

function factId(stage: DataStage, service: string, identity: Identity): string {
  return `data-fact:${stage}:${service}:${identity.kind}:${identity.value}`;
}

async function queryIdentities(input: {
  declared: ServiceWithCapability<ServiceDefinition, "data">;
  stage: DataStage;
  identities: readonly Identity[];
  ctx: DataCommandContext;
  results: ReadonlyMap<string, readonly ServiceDataResult[]>;
}): Promise<DataCapabilityFact[]> {
  const { declared, stage, identities, ctx, results } = input;
  const pluginContext = ctx.pluginContexts[declared.name];
  if (!pluginContext) throw new Error(`Service '${declared.name}' data capability 缺少 PluginContext`);
  const facts: DataCapabilityFact[] = [];
  for (const identity of identities) {
    const id = factId(stage, declared.name, identity);
    try {
      const result = await declared.capabilities.data.query(
        pluginContext,
        {
          identities: [identity],
          results,
        },
      );
      facts.push({
        id,
        status: "collected",
        stage,
        service: declared.name,
        identity,
        result,
        summary: declared.capabilities.data.summarize(result),
      });
    } catch (error) {
      facts.push({
        id,
        status: "failed",
        stage,
        service: declared.name,
        identity,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return facts;
}

function recordStage(
  ctx: DataCommandContext,
  stage: DataStage,
  service: string,
  facts: readonly DataCapabilityFact[],
  reused: readonly CollectedDataCapabilityFact[] = [],
): void {
  const collected = facts.filter(isCollected);
  const failures = facts.filter((fact) => fact.status === "failed");
  const hasEvidence = collected.length > 0 || reused.length > 0;
  const status = !failures.length ? "ok" : hasEvidence ? "partial" : "failed";
  const reason = failures.length
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

/**
 * Run the Service capabilities selected by doctor data and retain their outputs as Facts/Relations.
 * Command owns traversal and ordering; capability implementations only answer one Query at a time.
 */
export async function collectDataCapabilityFacts(input: {
  selections: readonly DataServiceSelection[];
  catalog: ServiceCatalog;
  inspectionFacts: DataInspectionFacts;
  config: DataConfig;
  ctx: DataCommandContext;
}): Promise<readonly DataCapabilityFact[]> {
  const { selections, catalog, inspectionFacts, config, ctx } = input;
  const collected: DataCapabilityFact[] = [];
  const expanders = selections.filter(({ service }) => (
    !!catalog.findWith(service, "data")?.capabilities.data.expands?.length
  ));

  for (const { service } of expanders) {
    const unavailable = dataServiceUnavailable(service, inspectionFacts);
    if (unavailable) {
      ctx.bundle.fill(dataOutcomeId("expand", service), { status: "unavailable", reason: unavailable });
      continue;
    }
    const declared = catalog.findWith(service, "data");
    if (!declared) throw new Error(`Doctor 未注册 Service '${service}' 的数据贡献能力`);
    const facts = await queryIdentities({
      declared,
      stage: "expand",
      identities: expandedIdentities(config, collected, catalog),
      ctx,
      results: completedResults(collected),
    });
    collected.push(...facts);
    recordStage(ctx, "expand", service, facts);
  }

  const expansionFacts = [...collected];
  const finalIdentities = expandedIdentities(config, expansionFacts, catalog);
  const expansionResults = completedResults(expansionFacts);
  for (const { service } of selections) {
    const unavailable = dataServiceUnavailable(service, inspectionFacts);
    if (unavailable) {
      ctx.bundle.fill(dataOutcomeId("provide", service), { status: "unavailable", reason: unavailable });
      continue;
    }
    const declared = catalog.findWith(service, "data");
    if (!declared) throw new Error(`Doctor 未注册 Service '${service}' 的数据贡献能力`);
    const reusable = expansionFacts.filter((fact): fact is CollectedDataCapabilityFact => (
      isCollected(fact) && fact.service === service
    ));
    const reusedIdentities = new Set(reusable.map((fact) => identityKey(fact.identity)));
    const facts = await queryIdentities({
      declared,
      stage: "provide",
      identities: finalIdentities.filter((identity) => !reusedIdentities.has(identityKey(identity))),
      ctx,
      results: expansionResults,
    });
    collected.push(...facts);
    recordStage(ctx, "provide", service, facts, reusable);
  }

  return collected;
}
