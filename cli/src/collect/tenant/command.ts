import { failureReport } from "../../report/context";
import { DATA_PAGE_KIND } from "@compforge/doctor-plugin";
import { prepareCommandRequirements } from "../../command/prepare";
import { CommandInputError, defineCommand, type CommandInput } from "../../command";
import { isInteractive } from "../../terminal/policy";
import { resolveTenant } from "../../terminal/tenant";
import { commandOptions, type CommandHostOption } from "../../command/options";
import { prepareDataCommand, type PreparedDataCommand } from "../data/context";
import { runCollectData } from "../data";
import { serializeData } from "../data/serialize";
import { renderDataReport } from "../data/report";
import { parseDataPagination } from "../data/query";
import type { DataOutput } from "../data/model";
import { openTenantDirectoryAccess } from "./access";
import type { CollectTenantCliOptions } from "./model";

export type TenantInput = CommandInput & Omit<CollectTenantCliOptions, CommandHostOption>;

export function createTenantInput(input: Omit<TenantInput, "idempotencyKey">): TenantInput {
  return { ...input, idempotencyKey() {
    return JSON.stringify([this.namespace ?? null, this.tenantId ?? null, this.tenantName ?? null,
      this.directoryProvider ?? null, this.tenantDirectoryService ?? null, this.tenantDirectoryPort ?? null,
      this.services ?? null, this.bizTypes ?? null, this.page ?? 1, this.pageSize ?? 20]);
  } };
}

/** @spec Tenant selects an identity, then uses the same data.page execution and evidence as Data. */
export const tenantCommand = defineCommand<TenantInput, DataOutput, PreparedDataCommand>({
  name: "doctor tenant",
  serialize: serializeData,
  render: async (context, result) => result.output ? renderDataReport(context, result) : failureReport("doctor tenant", result),
  validate: input => {
    if (input.tenantId !== undefined && !input.tenantId.trim() || input.tenantName !== undefined && !input.tenantName.trim()) {
      throw new CommandInputError("租户 ID 或名称不能为空");
    }
    if (input.tenantId !== undefined && input.tenantName !== undefined) throw new CommandInputError("--tenant-id 与 --tenant-name 不能同时使用");
    if (!isInteractive() && !input.tenantId && !input.tenantName) throw new CommandInputError("非交互模式需要 --tenant-id 或 --tenant-name 显式指定租户");
    try { parseDataPagination(input); } catch (error) { throw new CommandInputError(error instanceof Error ? error.message : String(error)); }
  },
  prepare: async (context, input) => {
    const directoryKind = input.tenantId ? undefined : input.tenantName ? "tenant.resolve" : "tenant.list";
    await prepareCommandRequirements(context, { plugin: { command: "doctor tenant", needs:
      [DATA_PAGE_KIND, ...(directoryKind ? [directoryKind] : [])].map(name => ({
        requirement: "required" as const, capability: { scope: "extension" as const, name }, purpose: "查询租户数据",
      })),
    } });
    await prepareCommandRequirements(context, { environment: { kubernetes: true } });
    const access = await openTenantDirectoryAccess({ options: { ...input, ...commandOptions(context) }, plugin: context.plugin, commandContext: context });
    if (!access) return undefined;
    const tenant = await resolveTenant({ tenantId: input.tenantId, tenantName: input.tenantName,
      profileName: access.config.profileName, directory: access.directory, commandContext: context });
    if (!tenant) return undefined;
    return prepareDataCommand({ ...input, ...commandOptions(context), tenantId: tenant.id, tenantName: tenant.name }, context.plugin.services, context, access.executor);
  },
  run: (context, prepared) => runCollectData(prepared, context.plugin),
});
