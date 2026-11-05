import type { ServiceSecretDataSource } from "@compforge/doctor-plugin";
import { openPluginContext } from "../../../plugin/context";
import { PROBE_RUNNABLE, type Probe } from "../../protocol";
import type { InspectCommandContext, InspectConfig, InspectFacts, InspectObservation, SecretConfigurationObservation } from "../model";

/** @spec Record selected Secret keys and their resource revision; a successful read can observe absent keys. */
export function makeSecretConfigurationProbe(service: string, source: ServiceSecretDataSource): Probe<InspectObservation, InspectFacts, InspectConfig, InspectCommandContext> {
  const id = `secret-config-${service}-${source.clientKey}`;
  return {
    id, evaluate: () => PROBE_RUNNABLE,
    run: async ctx => {
      const observation: SecretConfigurationObservation = {
        id, kind: "secret-configuration", schemaVersion: 1,
        producer: { origin: "core", id: "secret-configuration" }, service, dataSource: source.id,
        keys: source.keys, status: "unavailable", values: {}, missingKeys: [],
      };
      const started = performance.now();
      try {
        const context = await openPluginContext(ctx.executor, ctx.config.kube, {
          clients: ctx.command.clients, config: ctx.command.profile.pluginConfig, resources: ctx.resources,
          service: ctx.command.plugin.services.find(service)!, capability: { access: source.access },
        });
        try {
          const client = await context.clients.get(source);
          Object.assign(observation, client.target);
          Object.assign(observation, await client.read(), { status: "collected" });
        } finally { await context.dispose(); }
      } catch (error) {
        ctx.command.signal.throwIfAborted();
        observation.reason = `读取 Secret 配置失败：${service}/${source.id}（${error instanceof Error ? error.message : String(error)}）`;
      }
      ctx.log(`[collect] Secret 配置 ${service}/${source.id}：${observation.status}，${Object.keys(observation.values).length} 个 key 已采集，${observation.missingKeys.length} 个 key 不存在`);
      ctx.bundle.addStep({ id, title: `${service}/${source.id} Secret 配置`, risk: "observe",
        status: observation.status === "collected" ? "ok" : "unavailable", reason: observation.reason,
        durationMs: performance.now() - started, output: JSON.stringify(observation, null, 2), ext: "json" });
      return [observation];
    },
  };
}
