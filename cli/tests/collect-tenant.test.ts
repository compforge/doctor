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

test("tenant contributions share one generic Inspect entry", () => {
  expect(makeTenantInspects([]).map((inspect) => inspect.id)).toEqual([
    "tenant-identity",
    "tenant-contributions",
  ]);
});

test("tenant inspect aggregates generic contribution snapshots without probes", async () => {
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
    contributions: [{
      id: "inventory",
      title: "Tenant inventory",
      service: "inventory-api",
      collect: async (tenantId) => ({
        summary: [{ label: "Items", value: 1 }],
        tables: [{
          title: "Inventory",
          columns: ["Name", "Tenant", "Capacity"],
          rows: [["Resource 1", tenantId, "image_understanding"]],
          search: { column: 0, placeholder: "Search inventory" },
        }],
      }),
    }, {
      id: "configuration",
      title: "Tenant configuration",
      service: "config-api",
      collect: async () => ({
        summary: [{ label: "Configuration", value: 2 }],
        tables: [{
          title: "Configuration",
          columns: ["Scope", "Name", "Value"],
          rows: [["default", "enabled", true]],
        }],
        missingEvidence: ["runtime: unavailable"],
      }),
    }],
  };
  try {
    const facts = await runInspects(makeTenantInspects(ctx.contributions), ctx);
    const evidence = buildTenantEvidence([], facts);
    const coverage = buildTenantCoverage(evidence);

    expect(facts.contributions.inventory).toMatchObject({
      status: "collected",
      id: "inventory",
      tables: [{ rows: [["Resource 1", "tenant-1", "image_understanding"]] }],
    });
    expect(facts.contributions.configuration).toMatchObject({
      status: "collected",
      missingEvidence: ["runtime: unavailable"],
    });
    expect(coverage.map((item) => [item.goal, item.status])).toEqual([
      ["inventory", "sufficient"],
      ["configuration", "partial"],
    ]);
    const sections = buildTenantHtmlSections({ evidence, findings: [], coverage });
    expect(sections[0]?.html)
      .toContain("image_understanding");
    expect(sections[1]?.html).toContain("enabled");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tenant report IR rejects nested values at the Plugin boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-tenant-ir-test-"));
  const ctx: TenantCommandContext = {
    command: new CommandContext({}),
    config: {
      tenant: { id: "tenant-1", name: "alpha", displayName: "Alpha" },
      format: "json",
      reportName: "tenant-ir-test",
      profileName: "test",
    },
    bundle: new EvidenceBundle(root),
    contributions: [{
      id: "unsafe",
      title: "Unsafe",
      service: "unsafe-api",
      collect: async () => ({
        tables: [{ title: "Unsafe", columns: ["Value"], rows: [[{ secret: true } as never]] }],
      }),
    }],
  };
  try {
    const facts = await runInspects(makeTenantInspects(ctx.contributions), ctx);
    expect(facts.contributions.unsafe).toMatchObject({
      status: "failed",
      title: "Unsafe",
      reason: expect.stringContaining("must be a string, finite number, boolean, or null"),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
