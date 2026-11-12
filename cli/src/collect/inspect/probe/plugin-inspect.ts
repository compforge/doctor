import { validateProbeResult, type ServiceDefinition, type ServiceEvidenceFact, type InspectProbeExtension } from "@compforge/doctor-plugin";
import { recordExecutionFailure } from "../../../command/execution-scope";
import { invokeExtension } from "../../../plugin/extension";
import { openPluginContext } from "../../../plugin/context";
import { encodeObservationValue } from "../../../plugin/observation-value";
import { PROBE_RUNNABLE, type Probe } from "../../protocol";
import type { InspectCommandContext, InspectConfig, InspectFacts, InspectObservation, PluginInspectObservation } from "../model";

/** @spec Core invokes a Service contribution once; only the provider selects targets and interprets acquired data. */
export function makePluginInspectProbe(service: ServiceDefinition, declaration: InspectProbeExtension,
  probeFacts: readonly ServiceEvidenceFact[]): Probe<InspectObservation, InspectFacts, InspectConfig, InspectCommandContext> {
  const id = `plugin-inspect-${service.name}-${declaration.id}`;
  const title = `${service.name} · ${declaration.id}`;
  const unavailable = (ctx: InspectCommandContext, reason: string) => ctx.bundle.addStep({ id, title, risk: "observe", status: "unavailable", reason });
  return { id, evaluate: () => PROBE_RUNNABLE, onUnavailable: unavailable, onFailed: unavailable,
    run: async (ctx, _facts, config) => {
      const managed = await openPluginContext(ctx.executor, config.kube, {
        config: ctx.command.profile.pluginConfig, signal: ctx.command.signal,
        service, capability: declaration,
      });
      ctx.log(`[inspect] ${title}: start`);
      try {
        const observed = await invokeExtension(declaration, managed, { facts: probeFacts });
        validateProbeResult(observed.data);
        const result = observed.data;
        const encoded = encodeObservationValue(declaration.produces, result.value, `${service.name}/${declaration.id}`);
        const observation: PluginInspectObservation = {
          id, kind: "plugin-inspect", schemaVersion: 1, producer: { origin: "core", id: "plugin-inspect-adapter" },
          service: service.name, probe: declaration.id, status: result.status,
          ...(result.status !== "ok" ? { reason: result.reason } : {}),
          observationKind: declaration.produces.kind, observationSchemaVersion: declaration.produces.schemaVersion,
          value: encoded.value, summary: encoded.summary,
        };
        ctx.bundle.addStep({ id, title, risk: "observe", status: observation.status, reason: observation.reason,
          output: JSON.stringify(observation, null, 2), ext: "json" });
        ctx.log(`[inspect] ${title}: ${result.status}`);
        return [observation];
      } finally {
        const startedAt = Date.now();
        try { await managed.dispose(); }
        catch (error) { recordExecutionFailure(error, { phase: "cleanup", target: id, startedAt }); }
      }
    },
  };
}
