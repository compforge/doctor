import type {
  Identity,
  ServiceCatalog,
  ServiceDataResult,
  ServiceDefinition,
  ServiceWithCapability,
} from "@compforge/doctor-plugin";
import {
  PROBE_RUNNABLE,
  probeUnavailable,
  type Probe,
  type UpstreamProbeResult,
} from "../../protocol";
import type { DataCommandContext } from "../context";
import type {
  DataConfig,
  DataInspectionFacts,
  DataObservation,
  DataServiceSelection,
} from "../model";

type DataStage = DataObservation["stage"];

function dataProbeId(stage: DataStage, service: string): string {
  return `data-${stage}-${service}`;
}

function completedResults(
  progress: readonly UpstreamProbeResult<DataObservation>[],
): ReadonlyMap<string, readonly ServiceDataResult[]> {
  const results = new Map<string, ServiceDataResult[]>();
  for (const item of progress) {
    for (const observation of item.observations) {
      const serviceResults = results.get(observation.service) ?? [];
      serviceResults.push(observation.result);
      results.set(observation.service, serviceResults);
    }
  }
  return results;
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

function relationTargets(
  observation: DataObservation,
  catalog: ServiceCatalog,
): Identity[] {
  const declared = catalog.findWith(observation.service, "data");
  const expands = declared?.capabilities.data.expands ?? [];
  if (!expands.length) return [];

  if (observation.result.relations !== undefined) {
    return observation.result.relations.map((relation, index) => {
      const label = `${observation.service} relation[${index}]`;
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

  // Compatibility for Plugin API v1 implementations whose presentation summary also drove expansion.
  return Object.entries(declared!.capabilities.data.summarize(observation.result).identifiers)
    .filter(([kind, value]) => expands.includes(kind) && !!value?.trim())
    .map(([kind, value]) => ({ kind, value: value!.trim() }));
}

/**
 * @spec Data query expansion consumes capability Relations; presentation summaries never drive new implementations
 * @see {@link ../../../../docs/kernel.md}
 */
function expandedIdentities(
  config: DataConfig,
  progress: readonly UpstreamProbeResult<DataObservation>[],
  catalog: ServiceCatalog,
): Identity[] {
  const identities = new Map(
    config.ids.map((value) => {
      const identity = { kind: "biz_id", value };
      return [identityKey(identity), identity] as const;
    }),
  );
  for (const item of progress) {
    for (const observation of item.observations) {
      if (observation.stage !== "expand") continue;
      for (const identity of relationTargets(observation, catalog)) {
        identities.set(identityKey(identity), identity);
      }
    }
  }
  return [...identities.values()];
}

function evaluateDataService(service: string, facts: DataInspectionFacts) {
  const target = facts.services[service]?.target;
  if (!target) return probeUnavailable(`未选择 ${service}`);
  if (target.status !== "collected") return probeUnavailable(target.reason);
  const capability = facts.services[service]?.capability;
  if (capability?.status !== "collected") {
    return probeUnavailable(capability?.reason ?? `${service} 数据不可查询`);
  }
  return PROBE_RUNNABLE;
}

function makeObservation(
  declared: ServiceWithCapability<ServiceDefinition, "data">,
  stage: DataStage,
  identity: Identity,
  result: ServiceDataResult,
): DataObservation {
  return {
    id: `data-records:${stage}:${declared.name}:${identity.kind}:${identity.value}`,
    kind: "service-data-inspection",
    stage,
    service: declared.name,
    identity,
    result,
    summary: declared.capabilities.data.summarize(result),
  };
}

async function inspectIds(input: {
  declared: ServiceWithCapability<ServiceDefinition, "data">;
  stage: DataStage;
  identities: readonly Identity[];
  ctx: DataCommandContext;
  results: ReadonlyMap<string, readonly ServiceDataResult[]>;
}): Promise<{ observations: DataObservation[]; failures: string[] }> {
  const { declared, stage, identities, ctx, results } = input;
  const observations: DataObservation[] = [];
  const failures: string[] = [];
  for (const identity of identities) {
    try {
      const result = await declared.capabilities.data.inspect(
        ctx.pluginContexts[declared.name]!,
        {
          identities: [identity],
          inputId: identity.value,
          results,
        },
      );
      observations.push(makeObservation(declared, stage, identity, result));
    } catch (error) {
      failures.push(`${identity.kind}:${identity.value}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { observations, failures };
}

function makeExpansionProbe(
  declared: ServiceWithCapability<ServiceDefinition, "data">,
  priorExpanders: readonly string[],
  catalog: ServiceCatalog,
): Probe<DataObservation, DataInspectionFacts, DataConfig, DataCommandContext> {
  const service = declared.name;
  const id = dataProbeId("expand", service);
  return {
    id,
    dependsOn: priorExpanders.map((name) => dataProbeId("expand", name)),
    evaluate: (facts) => evaluateDataService(service, facts),
    onUnavailable: (ctx, reason) => ctx.bundle.fill(id, { status: "unavailable", reason }),
    run: async (ctx, facts, config, progress) => {
      const fact = facts.services[service]!;
      if (fact.target.status !== "collected" || !ctx.pluginContexts[service]) return [];
      const inspected = await inspectIds({
        declared,
        stage: "expand",
        identities: expandedIdentities(config, progress, catalog),
        ctx,
        results: completedResults(progress),
      });
      if (!inspected.observations.length && inspected.failures.length) {
        const reason = `扩展 ${service} 业务 ID 失败：${inspected.failures.join("；")}`;
        ctx.bundle.fill(id, { status: "failed", reason });
        return [];
      }
      ctx.bundle.fill(id, {
        status: "ok",
        output: `${JSON.stringify(inspected, null, 2)}\n`,
        ext: "json",
      });
      return inspected.observations;
    },
  };
}

function makeProviderProbe(
  declared: ServiceWithCapability<ServiceDefinition, "data">,
  expanders: readonly string[],
  catalog: ServiceCatalog,
): Probe<DataObservation, DataInspectionFacts, DataConfig, DataCommandContext> {
  const service = declared.name;
  const id = dataProbeId("provide", service);
  return {
    id,
    dependsOn: expanders.map((name) => dataProbeId("expand", name)),
    evaluate: (facts) => evaluateDataService(service, facts),
    onUnavailable: (ctx, reason) => ctx.bundle.fill(id, { status: "unavailable", reason }),
    run: async (ctx, facts, config, progress) => {
      const fact = facts.services[service]!;
      if (fact.target.status !== "collected" || !ctx.pluginContexts[service]) return [];
      const identities = expandedIdentities(config, progress, catalog);
      const reusable = new Map(
        progress
          .flatMap((item) => item.observations)
          .filter((observation) => observation.service === service)
          .map((observation) => [identityKey(observation.identity), observation]),
      );
      const missingIdentities = identities.filter((identity) => !reusable.has(identityKey(identity)));
      const inspected = await inspectIds({
        declared,
        stage: "provide",
        identities: missingIdentities,
        ctx,
        results: completedResults(progress),
      });
      if (!reusable.size && !inspected.observations.length && inspected.failures.length) {
        const reason = `查询 ${service} 数据失败：${inspected.failures.join("；")}`;
        ctx.bundle.fill(id, { status: "failed", reason });
        return [];
      }
      ctx.bundle.fill(id, {
        status: "ok",
        output: `${JSON.stringify({
          reusedIdentities: [...reusable.values()].map((observation) => observation.identity),
          observations: inspected.observations,
          failures: inspected.failures,
        }, null, 2)}\n`,
        ext: "json",
      });
      return inspected.observations;
    },
  };
}

export function makeDataServiceProbes(
  selections: readonly DataServiceSelection[],
  catalog: ServiceCatalog,
): Array<Probe<DataObservation, DataInspectionFacts, DataConfig, DataCommandContext>> {
  const expanders = selections
    .filter(({ service }) => !!catalog.findWith(service, "data")?.capabilities.data.expands?.length)
    .map(({ service }) => service);
  const probes: Array<Probe<DataObservation, DataInspectionFacts, DataConfig, DataCommandContext>> = [];
  for (const { service } of selections) {
    const declared = catalog.findWith(service, "data");
    if (!declared) throw new Error(`Doctor 未注册 Service '${service}' 的数据贡献能力`);
    const expanderIndex = expanders.indexOf(service);
    if (expanderIndex >= 0) {
      probes.push(makeExpansionProbe(declared, expanders.slice(0, expanderIndex), catalog));
    }
    probes.push(makeProviderProbe(declared, expanders, catalog));
  }
  return probes;
}
