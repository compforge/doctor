import { validateWorkloadProbeResult } from "@compforge/doctor-plugin";
import { recordExecutionFailure } from "../../../command/execution-scope";
import type {
  ServiceDefinition,
  ServiceEvidenceFact,
  WorkloadProbeExtension,
} from "@compforge/doctor-plugin";
import { invokeExtension } from "../../../plugin/extension";
import { openPluginContext } from "../../../plugin/context";
import { encodeObservationValue } from "../../../plugin/value";
import type { Probe } from "../../protocol";
import { PROBE_RUNNABLE, probeUnavailable } from "../../protocol";
import type {
  InspectCommandContext,
  InspectConfig,
  InspectFacts,
  InspectObservation,
  PluginWorkloadObservation,
} from "../model";

export function makePluginWorkloadProbe(
  service: ServiceDefinition,
  declaration: WorkloadProbeExtension,
  probeFacts: readonly ServiceEvidenceFact[],
): Probe<InspectObservation, InspectFacts, InspectConfig, InspectCommandContext> {
  const id = `plugin-workload-${service.name}-${declaration.workload}-${declaration.id}`;
  const targets = (facts: InspectFacts) => {
    if (facts.serviceTargets.status !== "collected") return [];
    const workload = facts.serviceTargets.services[service.name]?.workloads[declaration.workload];
    return workload?.podRuntime.status === "collected" ? workload.podRuntime.pods : [];
  };
  return {
    id,
    evaluate: (facts) => targets(facts).length
      ? PROBE_RUNNABLE
      : probeUnavailable(`${service.name}/${declaration.workload} 当前没有可探测的 Pod Instance`),
    onUnavailable: (ctx, reason) => ctx.bundle.addStep({
      id,
      title: `${service.name}/${declaration.workload} · ${declaration.id}`,
      risk: "observe",
      status: "unavailable",
      reason,
    }),
    onFailed: (ctx, reason) => ctx.bundle.addStep({
      id,
      title: `${service.name}/${declaration.workload} · ${declaration.id}`,
      risk: "observe",
      status: "unavailable",
      reason,
    }),
    run: async (ctx, facts, config) => {
      const managed = await openPluginContext(ctx.executor, config.kube, {
        config: ctx.command.profile.pluginConfig,
        signal: ctx.command.signal,
        service: service,
        capability: declaration,
      });
      try {
        const definition = service.workloads.find((item) => item.name === declaration.workload)!;
        const observations: PluginWorkloadObservation[] = [];
        for (const pod of targets(facts)) {
          if (managed.signal.aborted) break;
          const stepId = `${id}-${pod.pod}`;
          const startedAt = Date.now();
          try {
            const observed = await invokeExtension(declaration, managed, {
              instance: pod.instance,
              facts: probeFacts,
            });
            validateWorkloadProbeResult(observed.data);
            const result = observed.data;
            const label = `${service.name}/${declaration.workload}/${declaration.id}`;
            const encoded = encodeObservationValue(declaration.produces, result.value, label);
            const observation: PluginWorkloadObservation = {
              id: stepId,
              kind: "plugin-workload",
              status: result.status,
              ...(result.status !== "ok" ? { reason: result.reason } : {}),
              instance: pod.instance,
              schemaVersion: 1,
              producer: { origin: "core", id: "plugin-workload-adapter" },
              observationKind: declaration.produces.kind,
              observationSchemaVersion: declaration.produces.schemaVersion,
              service: service.name,
              workload: declaration.workload,
              namespace: config.namespace,
              pod: pod.pod,
              container: definition.container,
              probe: declaration.id,
              value: encoded.value,
              summary: encoded.summary,
            };
            observations.push(observation);
            ctx.bundle.addStep({
              id: stepId,
              title: `${service.name}/${declaration.workload}/${pod.pod} · ${declaration.id}`,
              risk: "observe",
              status: result.status,
              ...(result.status !== "ok" ? { reason: result.reason } : {}),
              output: JSON.stringify(observation, null, 2),
              ext: "json",
            });
          } catch (error) {
            recordExecutionFailure(error, { phase: "plugin-workload", target: stepId, startedAt });
            if (managed.signal.aborted) break;
            ctx.bundle.addStep({
              id: stepId,
              title: `${service.name}/${declaration.workload}/${pod.pod} · ${declaration.id}`,
              risk: "observe",
              status: "unavailable",
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        }
        return observations;
      } finally {
        const startedAt = Date.now();
        try { await managed.dispose(); }
        catch (error) { recordExecutionFailure(error, { phase: "cleanup", target: id, startedAt }); }
      }
    },
  };
}
