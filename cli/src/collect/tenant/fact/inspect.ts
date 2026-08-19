import type { Inspect } from "../../inspection";
import { modelSnapshot } from "../../../model";
import type {
  TenantCommandContext,
  TenantConfigurationScopeFacts,
  TenantFacts,
  TenantJsonValue,
} from "../model";

function jsonValue(value: unknown): TenantJsonValue {
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([name, child]) => [name, jsonValue(child)]));
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  return String(value ?? "");
}

export function makeTenantInspect(): Inspect<TenantFacts, TenantCommandContext> {
  return {
    id: "tenant-profile",
    run: async (ctx) => {
      const tenant: TenantFacts["tenant"] = {
        status: "collected",
        id: ctx.config.tenant.id,
        name: ctx.config.tenant.name,
        displayName: ctx.config.tenant.displayName,
      };
      let models: TenantFacts["models"];
      const modelsStarted = Date.now();
      try {
        const items = (await ctx.catalog.listAvailable(ctx.config.tenant.id)).map(modelSnapshot);
        models = { status: "collected", items };
        ctx.bundle.addStep({
          id: "tenant-model-catalog",
          title: "租户可用模型目录",
          risk: "observe",
          status: "ok",
          durationMs: Date.now() - modelsStarted,
          output: JSON.stringify(items, null, 2),
          ext: "json",
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        models = { status: "failed", reason };
        ctx.bundle.addStep({
          id: "tenant-model-catalog",
          title: "租户可用模型目录",
          risk: "observe",
          status: "failed",
          reason,
          durationMs: Date.now() - modelsStarted,
        });
      }

      if (!ctx.config.scopes.length || !ctx.prepareTenantConfigReader) {
        const reason = "Plugin 未提供 tenantConfiguration capability";
        return {
          tenant,
          models,
          configurationTarget: { status: "unavailable", reason },
          configuration: { status: "unavailable", reason },
        };
      }

      try {
        ctx.tenantConfigReader ??= await ctx.prepareTenantConfigReader();
        const target = ctx.tenantConfigReader.target;
        const scopes: TenantConfigurationScopeFacts = {};
        for (const scope of ctx.config.scopes) {
          const started = Date.now();
          try {
            const raw = await ctx.tenantConfigReader.loadTenantConfig(ctx.config.tenant.id, scope);
            const values = Object.fromEntries(
              Object.entries(raw).map(([name, value]) => [name, jsonValue(value)]),
            );
            scopes[scope] = { status: "collected", values };
            ctx.bundle.addStep({
              id: `tenant-config-${scope}`,
              title: `${scope} 租户配置`,
              risk: "observe",
              status: "ok",
              durationMs: Date.now() - started,
              output: JSON.stringify(values, null, 2),
              ext: "json",
            });
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            scopes[scope] = { status: "failed", reason };
            ctx.bundle.addStep({
              id: `tenant-config-${scope}`,
              title: `${scope} 租户配置`,
              risk: "observe",
              status: "failed",
              reason,
              durationMs: Date.now() - started,
            });
          }
        }
        return {
          tenant,
          models,
          configurationTarget: {
            status: "collected",
            service: ctx.config.tenantConfigService!,
            endpoint: target.endpoint,
            database: target.database,
            username: target.username,
            credentialSource: target.credentialSource,
          },
          configuration: { status: "collected", scopes },
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return {
          tenant,
          models,
          configurationTarget: { status: "failed", reason },
          configuration: { status: "failed", reason },
        };
      }
    },
  };
}
