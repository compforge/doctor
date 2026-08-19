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
  makeTenantInspect,
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

test("tenant inspect aggregates model capacities and tenant configuration without probes", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-tenant-test-"));
  const config: TenantConfig = {
    tenant: { id: "tenant-1", name: "alpha", displayName: "Alpha" },
    scopes: ["default", "runtime"],
    tenantConfigService: "config-api",
    format: "json",
    reportName: "tenant-test",
    profileName: "test",
  };
  const ctx: TenantCommandContext = {
    command: new CommandContext({}),
    config,
    bundle: new EvidenceBundle(root),
    catalog: {
      listAvailable: async () => [{
        id: "model-1",
        name: "Model 1",
        type: "llm",
        provider: "test",
        vendor: "sample",
        version: "2026-08",
        description: "Tenant default reasoning model",
        available: true,
        preset: true,
        billing: true,
        sourceModelId: "preset-model-1",
        contextLength: "128k",
        dimension: 4096,
        inputModalities: ["text", "image"],
        capacities: ["reason", "image_understanding"],
        features: ["tool_use"],
        pricing: {
          input: 1.2,
          output: 3.4,
          unit: "million_token",
          currency: "RMB",
          type: "token",
        },
        createdAt: "2026-08-01T00:00:00Z",
        updatedAt: "2026-08-19T00:00:00Z",
      }],
    },
    prepareTenantConfigReader: async () => ({
      target: {
        endpoint: "config-api:8080",
        database: "tenant",
        username: "doctor",
        credentialSource: "pod-env",
      },
      loadTenantConfig: async (_tenantId, scope) => ({ [`${scope}.enabled`]: true }),
    }),
  };
  try {
    const facts = await runInspects([makeTenantInspect()], ctx);
    const evidence = buildTenantEvidence([], facts);
    const coverage = buildTenantCoverage(evidence);

    expect(facts.models).toMatchObject({
      status: "collected",
      items: [{ capacities: ["reason", "image_understanding"] }],
    });
    expect(facts.configuration).toMatchObject({
      status: "collected",
      scopes: {
        default: { status: "collected", values: { "default.enabled": true } },
        runtime: { status: "collected", values: { "runtime.enabled": true } },
      },
    });
    expect(coverage.map((item) => [item.goal, item.status])).toEqual([
      ["model-catalog", "sufficient"],
      ["tenant-config", "sufficient"],
    ]);
    expect(buildTenantHtmlSections({ evidence, findings: [], coverage })[0]?.html)
      .toContain("image_understanding");
    expect(buildTenantHtmlSections({ evidence, findings: [], coverage })[0]?.html)
      .toContain("Tenant default reasoning model");
    expect(buildTenantHtmlSections({ evidence, findings: [], coverage })[0]?.html)
      .toContain("128k");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
