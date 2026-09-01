import type { Inspect } from "../../inspection";
import { collectedFact, failedFact } from "../../protocol";
import { modelSnapshot } from "../../../model";
import type { Fact } from "@compforge/doctor-plugin";
import type {
  TenantCommandContext,
  TenantCapabilityCollector,
  TenantCapabilityResult,
  TenantFacts,
} from "../model";

function modelFacts(models: readonly ReturnType<typeof modelSnapshot>[]): Fact[] {
  return [{
    factType: "value",
    kind: "model-summary",
    schemaVersion: 1,
    value: { count: models.length },
  }, ...models.map((model) => ({
    factType: "record" as const,
    kind: "model",
    schemaVersion: 1,
    recordKey: model.id,
    record: model,
  }))];
}

function makeTenantIdentityInspect(): Inspect<TenantFacts, TenantCommandContext> {
  return {
    id: "tenant-identity",
    run: async (ctx) => ({
      tenant: collectedFact("tenant.identity", "tenant-identity", {
        id: ctx.config.tenant.id,
        name: ctx.config.tenant.name,
        displayName: ctx.config.tenant.displayName,
      }),
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
            const safeResult: TenantCapabilityResult = result.kind === "models"
              ? {
                  result: {
                    resolution: {
                      inputId: identity.value,
                      resolvedAs: identity.kind,
                      identifiers: {
                        tenant_id: identity.value,
                        models: String(result.models.length),
                      },
                    },
                    facts: modelFacts(result.models.map(modelSnapshot)),
                  },
                }
              : { result: result.result };
            const id = capability.id;
            const fact = Object.assign(collectedFact(
              "tenant.capability-result",
              "tenant-capabilities",
              safeResult,
            ), {
              id,
              service: capability.service,
              capability: capability.capability,
            });
            facts.push(fact);
            ctx.bundle.addStep({
              id: `tenant-${id}`,
              title: `${capability.service} ${capability.capability} · facts`,
              risk: "observe",
              status: "ok",
              durationMs: Date.now() - started,
              output: JSON.stringify(fact, null, 2),
              ext: "json",
            });
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          facts.push(Object.assign(failedFact(
            "tenant.capability-result",
            "tenant-capabilities",
            reason,
          ), {
            id: capability.id,
            service: capability.service,
            capability: capability.capability,
          }));
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
