import type {
  ServiceDefinition,
  ServiceEvidenceFact,
  ServiceWorkloadProbe,
} from "@compforge/doctor-plugin";
import { openPluginContext } from "../../../plugin/context";
import { validateObservationValue } from "../../../plugin/observation";
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
  declaration: ServiceWorkloadProbe,
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
        env: config.profileName,
        config: ctx.command.profile.pluginConfig,
        service: { name: service.name },
        capability: declaration,
        command: "doctor inspect",
        authorization: ctx.authorization,
      });
      try {
        const definition = service.workloads.find((item) => item.name === declaration.workload)!;
        const observations: PluginWorkloadObservation[] = [];
        for (const pod of targets(facts)) {
          const stepId = `${id}-${pod.pod}`;
          try {
            const observed = await declaration.probe(managed, {
              instance: {
                kind: "kubernetes-pod",
                namespace: config.namespace,
                pod: pod.pod,
                container: definition.container,
              },
              facts: probeFacts,
            });
            const value = validateObservationValue(
              declaration.produces,
              observed,
              `${service.name}/${declaration.workload}/${declaration.id}`,
            );
            const observation: PluginWorkloadObservation = {
              id: stepId,
              kind: "plugin-workload",
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
              value,
            };
            observations.push(observation);
            ctx.bundle.addStep({
              id: stepId,
              title: `${service.name}/${declaration.workload}/${pod.pod} · ${declaration.id}`,
              risk: "observe",
              status: "ok",
              output: JSON.stringify(observation, null, 2),
              ext: "json",
            });
          } catch (error) {
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
        await managed.dispose();
      }
    },
  };
}
