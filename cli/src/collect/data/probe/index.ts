import type { ServiceCatalog, ServiceWithCapability } from "@compforge/doctor-plugin";
import type { ServiceDataResult, ServiceDefinition } from "@compforge/doctor-plugin";
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

function expandedInputIds(
  config: DataConfig,
  progress: readonly UpstreamProbeResult<DataObservation>[],
  catalog: ServiceCatalog,
): string[] {
  const ids = new Set(config.ids);
  for (const item of progress) {
    for (const observation of item.observations) {
      if (observation.stage !== "expand") continue;
      const declared = catalog.findWith(observation.service, "data");
      if (!declared?.capabilities.data.expands?.length) continue;
      for (const value of Object.values(declared.capabilities.data.summarize(observation.result).identifiers)) {
        if (value?.trim()) ids.add(value.trim());
      }
    }
  }
  return [...ids];
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
  inputId: string,
  result: ServiceDataResult,
): DataObservation {
  return {
    id: `data-records:${stage}:${declared.name}:${inputId}`,
    kind: "service-data-inspection",
    stage,
    service: declared.name,
    result,
    summary: declared.capabilities.data.summarize(result),
  };
}

async function inspectIds(input: {
  declared: ServiceWithCapability<ServiceDefinition, "data">;
  stage: DataStage;
  ids: readonly string[];
  ctx: DataCommandContext;
  results: ReadonlyMap<string, readonly ServiceDataResult[]>;
}): Promise<{ observations: DataObservation[]; failures: string[] }> {
  const { declared, stage, ids, ctx, results } = input;
  const observations: DataObservation[] = [];
  const failures: string[] = [];
  for (const inputId of ids) {
    try {
      const result = await declared.capabilities.data.inspect(
        ctx.pluginContexts[declared.name]!,
        {
        inputId,
        results,
        },
      );
      observations.push(makeObservation(declared, stage, inputId, result));
    } catch (error) {
      failures.push(`${inputId}: ${error instanceof Error ? error.message : String(error)}`);
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
        ids: expandedInputIds(config, progress, catalog),
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
      const ids = expandedInputIds(config, progress, catalog);
      const reusable = new Map(
        progress
          .flatMap((item) => item.observations)
          .filter((observation) => observation.service === service)
          .map((observation) => [observation.result.resolution.inputId, observation]),
      );
      const missingIds = ids.filter((inputId) => !reusable.has(inputId));
      const inspected = await inspectIds({
        declared,
        stage: "provide",
        ids: missingIds,
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
          reusedInputIds: [...reusable.keys()],
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
