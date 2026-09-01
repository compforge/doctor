import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginDefinition } from "@compforge/doctor-plugin";
import { DOCTOR_CLI_VERSION } from "../../app/version";
import type { CommandContext } from "../../command";
import { resolveTenant } from "../../model";
import { terminalStderr, terminalStdout } from "../../terminal/output";
import { runCollect } from "../engine";
import { EvidenceBundle } from "../evidence";
import { evaluateCollectOutcome } from "../outcome";
import { writeHtmlReport } from "../output/html";
import { openTenantAccess } from "./access";
import {
  parseTenantOutputFormat,
  tenantReportName,
} from "./config";
import { buildTenantCoverage, buildTenantEvidence, tenantDetectors } from "./detector";
import { makeTenantInspects } from "./fact/inspect";
import type {
  CollectTenantCliOptions,
  TenantCommandContext,
  TenantConfig,
  TenantDiagnosis,
  TenantFacts,
} from "./model";
import {
  buildTenantHtml,
  buildTenantHtmlSections,
  buildTenantSummary,
} from "./render";

export * from "./access";
export * from "./config";
export * from "./detector";
export * from "./fact/inspect";
export * from "./model";
export * from "./render";

/**
 * @spec doctor tenant 以 tenant_id Query 组合 Model Catalog 与 Inspect contribution，不理解 Plugin 业务概念
 * @see {@link ../../../docs/commands/tenant.md}
 */
export async function runCollectTenant(
  opts: CollectTenantCliOptions,
  plugin: PluginDefinition,
  commandContext: CommandContext,
): Promise<number> {
  const startedAt = new Date().toISOString();
  let retainedStaging: string | undefined;
  let format;
  try {
    format = parseTenantOutputFormat(opts.format);
  } catch (error) {
    terminalStderr.error(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  let access;
  try {
    access = await openTenantAccess({
      options: opts,
      plugin,
      commandContext,
    });
  } catch (error) {
    terminalStderr.error(`[tenant] ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (!access) return 130;

  try {
    const tenant = await resolveTenant({
      tenantId: opts.tenantId,
      tenantName: opts.tenantName,
      profileName: access.config.profileName,
      directory: access.directory,
      commandContext,
    });
    if (!tenant) {
      terminalStderr.warning("[tenant] 已取消\n");
      return 130;
    }
    terminalStdout.write(`[tenant] tenant: ${tenant.name}（${tenant.id}）\n`);
    terminalStdout.write(
      `[tenant] namespace: ${access.config.kubernetes.namespace}`
      + `（${access.config.kubernetes.namespaceSource}）\n`,
    );

    const reportName = tenantReportName(tenant.id);
    const config: TenantConfig = {
      tenant,
      format,
      reportName,
      profileName: access.config.profileName,
    };
    const stagingRoot = mkdtempSync(join(tmpdir(), "doctor-tenant-"));
    const staging = join(stagingRoot, reportName);
    retainedStaging = staging;
    commandContext.artifacts.add("tenant", staging);
    const bundle = new EvidenceBundle(staging);
    const ctx: TenantCommandContext = {
      command: commandContext,
      config,
      bundle,
      capabilities: access.capabilities,
    };
    const execution = await runCollect({
      ctx,
      config,
      inspects: makeTenantInspects(access.capabilities),
      planProbes: () => [],
      log: (line) => terminalStdout.write(`${line}\n`),
      buildEvidence: buildTenantEvidence,
      detectors: tenantDetectors,
      buildCoverage: buildTenantCoverage,
    });
    const facts: Readonly<TenantFacts> = execution.facts;
    const diagnosis: TenantDiagnosis = execution.diagnosis;

    bundle.writeSummary(buildTenantSummary(diagnosis));
    bundle.writeManifest({
      doctorVersion: DOCTOR_CLI_VERSION,
      target: { tenant_id: tenant.id, tenant_name: tenant.name },
      inspectionFacts: { ...facts },
      params: {
        capabilities: access.capabilities.map(({ id, service, capability }) => ({
          id,
          service,
          capability,
        })),
        output_format: format,
      },
      startedAt,
      finishedAt: new Date().toISOString(),
    });
    writeFileSync(join(staging, "diagnosis.json"), `${JSON.stringify(diagnosis, null, 2)}\n`, "utf8");

    if (format !== "json") {
      writeHtmlReport(staging, join(staging, "report.html"), {
        title: "doctor tenant",
        profileName: config.profileName,
        summaryHtml: buildTenantHtml(diagnosis),
        sections: buildTenantHtmlSections(diagnosis),
      });
    }
    const outcome = evaluateCollectOutcome(
      diagnosis.coverage.map((item) => item.status !== "insufficient"),
    );
    return outcome.exitCode;
  } catch (error) {
    const retained = retainedStaging ? `；原始证据保留在目录: ${retainedStaging}` : "";
    terminalStderr.error(
      `[tenant] ${error instanceof Error ? error.message : String(error)}${retained}\n`,
    );
    return 1;
  } finally {
    await access.dispose();
  }
}
