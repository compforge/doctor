import { htmlTable } from "../../output/html";
import type { TenantFacet } from "../facet";
import type {
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

function display(value: TenantJsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function rows(facts: TenantFacts): string[][] {
  const configuration = facts.configuration;
  if (configuration.status !== "collected") return [];
  return Object.entries(configuration.scopes).flatMap(([scope, fact]) => (
    fact.status === "collected"
      ? Object.entries(fact.values).map(([name, value]) => [scope, name, display(value)])
      : [[scope, "—", `unavailable: ${fact.reason}`]]
  ));
}

export const CONFIGURATION_TENANT_FACET: TenantFacet = {
  inspect: {
    id: "tenant-configuration",
    run: async (ctx) => {
      if (!ctx.config.scopes.length || !ctx.prepareTenantConfigReader) {
        const reason = "Plugin 未提供 tenantConfiguration capability";
        return {
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
          configurationTarget: { status: "failed", reason },
          configuration: { status: "failed", reason },
        };
      }
    },
  },
  coverage: (facts) => {
    if (facts.configuration.status === "unavailable") return undefined;
    const scopes = facts.configuration.status === "collected"
      ? Object.values(facts.configuration.scopes)
      : [];
    const collected = scopes.filter((scope) => scope.status === "collected").length;
    const missing = facts.configuration.status === "collected"
      ? Object.entries(facts.configuration.scopes).flatMap(([scope, fact]) => (
          fact.status === "collected" ? [] : [`${scope}: ${fact.reason}`]
        ))
      : [facts.configuration.reason];
    return {
      goal: "tenant-config",
      status: missing.length === 0 ? "sufficient" : collected > 0 ? "partial" : "insufficient",
      missingEvidence: missing,
    };
  },
  render: (facts) => {
    const configurationRows = rows(facts);
    return {
      summary: [`租户配置项：${configurationRows.length}`],
      markdown: [
        "## Tenant configuration",
        "",
        "| scope | name | value |",
        "|---|---|---|",
        ...configurationRows.map((row) => `| ${row.join(" | ")} |`),
      ],
      sections: [{
        title: "Tenant / Configuration",
        html: htmlTable(
          ["Scope", "Name", "Value"],
          configurationRows,
          { search: { column: 1, placeholder: "按配置名检索" } },
        ),
      }],
    };
  },
};
