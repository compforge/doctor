import { PROBE_RUNNABLE, probeUnavailable, type Probe } from "../../protocol";
import type {
  InspectCollectContext,
  InspectConfig,
  InspectFacts,
  InspectObservation,
  JsonValue,
  TenantConfigObservation,
  TenantConfigScope,
} from "../model";

function jsonValue(value: unknown): JsonValue {
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([name, child]) => [name, jsonValue(child)]));
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  return String(value ?? "");
}

export function makeTenantConfigProbe(
  scope: TenantConfigScope,
): Probe<InspectObservation, InspectFacts, InspectConfig, InspectCollectContext> {
  const id = `config-tenant-${scope}`;
  return {
    id,
    evaluate: (facts, config) => {
      if (!config.tenantId) return probeUnavailable("未指定 --tenant-id");
      return facts.tenantDatabaseTarget.status === "collected"
        ? PROBE_RUNNABLE
        : probeUnavailable(facts.tenantDatabaseTarget.reason);
    },
    onUnavailable: (ctx, reason) => ctx.bundle.addStep({
      id,
      title: `${scope} 租户配置`,
      risk: "observe",
      status: "unavailable",
      reason,
    }),
    run: async (ctx, facts, config) => {
      if (
        !config.tenantId
        || facts.tenantDatabaseTarget.status !== "collected"
        || !ctx.tenantConfigReader
      ) return [];
      const started = Date.now();
      try {
        const rawValues = await ctx.tenantConfigReader.loadTenantConfig(
          config.tenantId,
          scope,
        );
        const values = Object.fromEntries(
          Object.entries(rawValues).map(([name, value]) => [name, jsonValue(value)]),
        );
        const observation: TenantConfigObservation = {
          id,
          kind: "tenant-config",
          tenantId: config.tenantId,
          tenantName: config.tenantName,
          scope,
          values,
        };
        ctx.bundle.addStep({
          id,
          title: `${scope} 租户配置`,
          risk: "observe",
          status: "ok",
          durationMs: Date.now() - started,
          output: JSON.stringify(observation, null, 2),
          ext: "json",
        });
        return [observation];
      } catch (error) {
        const reason = `读取 tenant=${config.tenantId} scope=${scope} 配置失败：${error instanceof Error ? error.message : String(error)}`;
        ctx.bundle.addStep({
          id,
          title: `${scope} 租户配置`,
          risk: "observe",
          status: "failed",
          reason,
          durationMs: Date.now() - started,
        });
        return [];
      }
    },
  };
}
