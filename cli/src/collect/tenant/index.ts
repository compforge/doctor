import type { PluginDefinition } from "@compforge/doctor-plugin";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOCTOR_CLI_VERSION } from "../../app/version";
import type { CommandContext } from "../../command";
import { commandOutcome, type CommandResult } from "../../command";
import { resolveTenant } from "../../model";

import { useLogger } from "../../terminal/log";
import { runCollect } from "../engine";
import { EvidenceBundle } from "../evidence";
import { collectCommandOutcome, evaluateCollectOutcome } from "../outcome";
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
): Promise<CommandResult<void>> {
  const startedAt = new Date().toISOString();
  let retainedStaging: string | undefined;
  let format;
  try {
    format = parseTenantOutputFormat(opts.format);
  } catch (error) {
    useLogger().error(`${error instanceof Error ? error.message : String(error)}`);
    return commandOutcome(2);
  }
  if (format === "summary" && opts.output) {
    useLogger().error("--format summary 直接输出到终端，不支持 --output");
    return commandOutcome(2);
  }

  let access;
  try {
    access = await openTenantAccess({
      options: opts,
      plugin,
      commandContext,
    });
  } catch (error) {
    useLogger("tenant").error(`${error instanceof Error ? error.message : String(error)}`);
    return commandOutcome(2);
  }
  if (!access) return commandOutcome(130);

  try {
    const tenant = await resolveTenant({
      tenantId: opts.tenantId,
      tenantName: opts.tenantName,
      profileName: access.config.profileName,
      directory: access.directory,
      commandContext,
    });
    if (!tenant) {
      useLogger("tenant").warn("已取消");
      return commandOutcome(130);
    }
    useLogger("tenant").info(`tenant: ${tenant.name}（${tenant.id}）`);
    useLogger("tenant").info(`namespace: ${access.config.kubernetes.namespace}`
      + `（${access.config.kubernetes.namespaceSource}）`);

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
    commandContext.artifacts.add({ command: "tenant", path: staging });
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
      log: (line) => useLogger().info(`${line}`),
      buildEvidence: buildTenantEvidence,
      detectors: tenantDetectors,
      buildCoverage: buildTenantCoverage,
    });
    const facts: Readonly<TenantFacts> = execution.facts;
    const diagnosis: TenantDiagnosis = execution.diagnosis;

    bundle.writeSummary(buildTenantSummary(diagnosis));
    bundle.writeCollection({
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

    const outcome = evaluateCollectOutcome(
      diagnosis.coverage.map((item) => item.status),
    );
    // The evidence directory is registered on the shared command context; return
    // its reference so root finalize can serialize and deliver the summary.
    return { ...collectCommandOutcome(outcome), artifacts: commandContext.artifacts.list() };
  } catch (error) {
    const retained = retainedStaging ? `；原始证据保留在目录: ${retainedStaging}` : "";
    useLogger("tenant").error(`${error instanceof Error ? error.message : String(error)}${retained}`);
    return commandOutcome(1);
  } finally {
    await access.dispose();
  }
}
