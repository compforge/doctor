import type { Inspect } from "../../inspection";
import { TENANT_FACETS } from "../facets";
import type { TenantCommandContext, TenantFacts } from "../model";

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

/**
 * @spec Tenant identity 与各领域 facet 是独立 Inspect；增加 facet 不修改 Tenant 编排流程
 * @see {@link ../../../../docs/commands/tenant.md}
 */
export function makeTenantInspects(): Inspect<TenantFacts, TenantCommandContext>[] {
  return [
    makeTenantIdentityInspect(),
    ...TENANT_FACETS.map((facet) => facet.inspect),
  ];
}
