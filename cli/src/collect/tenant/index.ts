import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  PluginDefinition,
  TenantConfigReader,
} from "@compforge/doctor-plugin";
import { DOCTOR_CLI_VERSION } from "../../app/version";
import type { CommandContext } from "../../command";
import { createKubernetesExecutor } from "../../command/kubernetes-target";
import { resolveKubernetesCommandContext } from "../../command";
import { openModelDiscoveryAccess, resolveTenant } from "../../model";
import { openPluginContext } from "../../plugin/context";
import { terminalStderr, terminalStdout } from "../../terminal/output";
import { runDiagnosis } from "../engine";
import { EvidenceBundle } from "../evidence";
import { runInspects } from "../inspect-engine";
import { evaluateCollectOutcome } from "../outcome";
import { writeHtmlReport } from "../output/html";
import {
  parseTenantOutputFormat,
  tenantReportName,
} from "./config";
import { buildTenantCoverage, buildTenantEvidence } from "./detector";
import { makeTenantInspect } from "./fact/inspect";
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

export * from "./config";
export * from "./detector";
export * from "./fact/inspect";
export * from "./model";
export * from "./render";

function tenantConfigReaderFactory(input: {
  plugin: PluginDefinition;
  opts: CollectTenantCliOptions;
  commandContext: CommandContext;
  access: NonNullable<Awaited<ReturnType<typeof openModelDiscoveryAccess>>>;
  onDispose: (close: () => Promise<void>) => void;
}): (() => Promise<TenantConfigReader>) | undefined {
  const capability = input.plugin.tenantConfiguration;
  if (!capability) return undefined;
  const service = input.opts.tenantConfigService?.trim() || capability.databaseService;
  return async () => {
    const executor = createKubernetesExecutor(input.access.config);
    const context = await openPluginContext(executor, {
      namespace: input.access.config.kubernetes.namespace,
      kubeconfig: input.access.config.kubernetes.kubeconfig,
      context: input.access.config.kubernetes.context,
    }, {
      env: input.commandContext.profile.name,
      config: input.commandContext.profile.pluginConfig,
      databaseIdentity: input.commandContext.profile.value.db?.user
          && input.commandContext.profile.value.db.password
        ? {
            user: input.commandContext.profile.value.db.user,
            password: input.commandContext.profile.value.db.password,
          }
        : undefined,
      service: { name: service },
      command: "doctor tenant",
      capability,
      authorization: resolveKubernetesCommandContext(executor, input.commandContext).access,
    });
    try {
      const reader = await capability.createReader(context);
      input.onDispose(() => context.dispose());
      return reader;
    } catch (error) {
      await context.dispose();
      throw error;
    }
  };
}

/**
 * @spec doctor tenant 只汇总租户配置与 Model Catalog Facts，不创建 inference handle 或主动模型流量
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
    access = await openModelDiscoveryAccess({
      ...opts,
      command: "doctor tenant",
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
      scopes: plugin.tenantConfiguration?.scopes ?? [],
      tenantConfigService: opts.tenantConfigService?.trim()
        || plugin.tenantConfiguration?.databaseService,
      format,
      reportName,
      profileName: access.config.profileName,
    };
    const stagingRoot = mkdtempSync(join(tmpdir(), "doctor-tenant-"));
    const staging = join(stagingRoot, reportName);
    retainedStaging = staging;
    commandContext.artifacts.add("tenant", staging);
    const bundle = new EvidenceBundle(staging);
    let closeTenantConfig: (() => Promise<void>) | undefined;
    const ctx: TenantCommandContext = {
      command: commandContext,
      config,
      bundle,
      catalog: access.catalog,
      prepareTenantConfigReader: tenantConfigReaderFactory({
        plugin,
        opts,
        commandContext,
        access,
        onDispose: (close) => { closeTenantConfig = close; },
      }),
    };
    let facts: Readonly<TenantFacts>;
    let diagnosis: TenantDiagnosis;
    try {
      facts = await runInspects([makeTenantInspect()], ctx, (line) => terminalStdout.write(`${line}\n`));
      diagnosis = await runDiagnosis({
        ctx,
        facts,
        config,
        probes: [],
        log: (line) => terminalStdout.write(`${line}\n`),
        buildEvidence: buildTenantEvidence,
        detectors: [],
        buildCoverage: buildTenantCoverage,
      });
    } finally {
      await closeTenantConfig?.();
    }

    bundle.writeSummary(buildTenantSummary(diagnosis));
    bundle.writeManifest({
      doctorVersion: DOCTOR_CLI_VERSION,
      target: { tenant_id: tenant.id, tenant_name: tenant.name },
      inspectionFacts: { ...facts },
      params: {
        tenant_config_scopes: config.scopes,
        tenant_config_service: config.tenantConfigService ?? null,
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
