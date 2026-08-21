import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandContext } from "../src/command";
import { EvidenceBundle } from "../src/collect/evidence";
import { runInspects } from "../src/collect/inspect-engine";
import {
  buildTenantCoverage,
  buildTenantEvidence,
  buildTenantHtmlSections,
  makeTenantInspects,
  safeTenantId,
  tenantReportName,
  type TenantCommandContext,
  type TenantConfig,
} from "../src/collect/tenant";

test("tenant report name keeps the tenant identity", () => {
  const now = new Date(2026, 7, 19, 15, 4, 5);
  expect(safeTenantId("tenant/team:1")).toBe("tenant-team-1");
  expect(tenantReportName("tenant/team:1", now))
    .toBe("doctor-tenant-tenant-team-1-20260819-150405");
});

test("tenant capabilities share one generic Inspect entry", () => {
  expect(makeTenantInspects([]).map((inspect) => inspect.id)).toEqual([
    "tenant-identity",
    "tenant-capabilities",
  ]);
});

test("tenant command combines model catalog and Inspect Capabilities as facts", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-tenant-test-"));
  const config: TenantConfig = {
    tenant: { id: "tenant-1", name: "alpha", displayName: "Alpha" },
    format: "json",
    reportName: "tenant-test",
    profileName: "test",
  };
  const ctx: TenantCommandContext = {
    command: new CommandContext({}),
    config,
    bundle: new EvidenceBundle(root),
    capabilities: [{
      id: "models",
      service: "model-api",
      capability: "modelCatalog",
      query: async (identity) => [{
        kind: "models",
        models: [{
          id: "model-1",
          name: `Model for ${identity.value}`,
          type: "llm",
          provider: "test",
          apiKey: "must-not-leak",
        } as never],
      }],
    }, {
      id: "inspect:config-api",
      service: "config-api",
      capability: "inspect",
      query: async (identity) => [{
        kind: "data",
        fact: {
          kind: "tenant-configuration",
          service: "config-api",
          resolution: { inputId: identity.value, resolvedAs: "tenant_id" },
          data: { configuration: { enabled: true } },
          relations: [{
            kind: "owns",
            from: identity,
            to: { kind: "bot_id", value: "bot-1" },
          }],
          missingEvidence: ["runtime: unavailable"],
        },
        summary: { resolvedAs: "tenant_id", identifiers: { tenant_id: identity.value } },
      }, {
        kind: "data",
        fact: {
          kind: "tenant-intention",
          service: "config-api",
          resolution: { inputId: identity.value, resolvedAs: "tenant_id" },
          data: { intentions: [{ id: "intent-1" }] },
        },
        summary: { resolvedAs: "tenant_id", identifiers: { tenant_id: identity.value } },
      }],
    }],
  };
  try {
    const facts = await runInspects(makeTenantInspects(ctx.capabilities), ctx);
    const evidence = buildTenantEvidence([], facts);
    const coverage = buildTenantCoverage(evidence);

    expect(facts.capabilityFacts[0]).toMatchObject({
      status: "collected",
      id: "models",
      kind: "models",
      models: [{ name: "Model for tenant-1" }],
    });
    expect(JSON.stringify(facts.capabilityFacts[0])).not.toContain("must-not-leak");
    expect(facts.capabilityFacts[1]).toMatchObject({
      status: "collected",
      id: "inspect:config-api:tenant-configuration",
      kind: "data",
      fact: { data: { configuration: { enabled: true } } },
    });
    expect(facts.capabilityFacts[1]).toMatchObject({
      fact: { relations: [{ to: { kind: "bot_id", value: "bot-1" } }] },
    });
    expect(facts.capabilityFacts[2]).toMatchObject({
      status: "collected",
      id: "inspect:config-api:tenant-intention",
      fact: { data: { intentions: [{ id: "intent-1" }] } },
    });
    expect(coverage.map((item) => [item.goal, item.status])).toEqual([
      ["models", "sufficient"],
      ["inspect:config-api:tenant-configuration", "partial"],
      ["inspect:config-api:tenant-intention", "sufficient"],
    ]);
    const sections = buildTenantHtmlSections({ evidence, findings: [], coverage });
    expect(sections[0]?.html).toContain("Model for tenant-1");
    expect(sections[1]?.html).toContain("enabled");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tenant command retains capability failures as evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-tenant-failure-test-"));
  const ctx: TenantCommandContext = {
    command: new CommandContext({}),
    config: {
      tenant: { id: "tenant-1", name: "alpha", displayName: "Alpha" },
      format: "json",
      reportName: "tenant-failure-test",
      profileName: "test",
    },
    bundle: new EvidenceBundle(root),
    capabilities: [{
      id: "inspect:unsafe-api",
      service: "unsafe-api",
      capability: "inspect",
      query: async () => { throw new Error("source unavailable"); },
    }],
  };
  try {
    const facts = await runInspects(makeTenantInspects(ctx.capabilities), ctx);
    expect(facts.capabilityFacts[0]).toMatchObject({
      status: "failed",
      id: "inspect:unsafe-api",
      reason: "source unavailable",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
