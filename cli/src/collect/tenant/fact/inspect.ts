import type { Inspect } from "../../inspection";
import { modelSnapshot } from "../../../model";
import type {
  TenantCommandContext,
  TenantCapabilityCollector,
  TenantFacts,
} from "../model";

function makeTenantIdentityInspect(): Inspect<TenantFacts, TenantCommandContext> {
  return {
    id: "tenant-identity",
    run: async (ctx) => ({
      tenant: {
        status: "collected",
        id: ctx.config.tenant.id,
        name: ctx.config.tenant.name,
        displayName: ctx.config.tenant.displayName,
      },
    }),
  };
}

function makeTenantCapabilitiesInspect(
  capabilities: readonly TenantCapabilityCollector[],
): Inspect<TenantFacts, TenantCommandContext> {
  return {
    id: "tenant-capabilities",
    run: async (ctx) => {
      const facts: TenantFacts["capabilityFacts"][number][] = [];
      const identity = { kind: "tenant_id" as const, value: ctx.config.tenant.id };
      for (const capability of capabilities) {
        const started = Date.now();
        try {
          const results = await capability.query(identity);
          for (const result of results) {
            const safeResult = result.kind === "models"
              ? { ...result, models: result.models.map(modelSnapshot) }
              : result;
            const id = capability.id;
            const fact = {
              status: "collected" as const,
              id,
              service: capability.service,
              capability: capability.capability,
              ...safeResult,
            };
            facts.push(fact);
            ctx.bundle.addStep({
              id: `tenant-${id}`,
              title: `${capability.service} ${capability.capability} · ${
                result.kind === "data" ? "facts" : "models"
              }`,
              risk: "observe",
              status: "ok",
              durationMs: Date.now() - started,
              output: JSON.stringify(fact, null, 2),
              ext: "json",
            });
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          facts.push({
            status: "failed",
            id: capability.id,
            service: capability.service,
            capability: capability.capability,
            reason,
          });
          ctx.bundle.addStep({
            id: `tenant-${capability.id}`,
            title: `${capability.service} ${capability.capability}`,
            risk: "observe",
            status: "failed",
            reason,
            durationMs: Date.now() - started,
          });
        }
      }
      return { capabilityFacts: facts };
    },
  };
}

/**
 * @spec Tenant Command 按 tenant_id 选择 Capability 并保留其 Fact/Relation，Core 不理解 Plugin 业务领域
 * @see {@link ../../../../docs/commands/tenant.md}
 */
export function makeTenantInspects(
  capabilities: readonly TenantCapabilityCollector[],
): Inspect<TenantFacts, TenantCommandContext>[] {
  return [
    makeTenantIdentityInspect(),
    makeTenantCapabilitiesInspect(capabilities),
  ];
}
