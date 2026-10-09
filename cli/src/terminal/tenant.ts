import type { TenantDirectory, TenantSummary } from "@compforge/doctor-plugin";
import { defineCommandDecision, type CommandContext } from "../command";
import { recentSelectionsForInteractive, type RecentSelections } from "../infra/recent";
import { isInteractive } from "./policy";
import { promptTenantChoice } from "./tenant-selection";

const tenantSelectionDecision = defineCommandDecision<TenantSummary | undefined>("tenant-selection");

export async function resolveTenant(input: {
  tenantId?: string;
  tenantName?: string;
  profileName?: string;
  directory: TenantDirectory;
  commandContext?: CommandContext;
  promptTitle?: string;
  interactive?: boolean;
  recent?: RecentSelections;
  /** Keep probe identity decisions separate from command query filters. */
  scope?: string;
  prompt?: (tenants: readonly TenantSummary[]) => Promise<TenantSummary | undefined>;
}): Promise<TenantSummary | undefined> {
  const resolve = async (): Promise<TenantSummary | undefined> => {
    const tenantId = input.tenantId?.trim();
    const tenantName = input.tenantName?.trim();
    if (tenantId && tenantName) throw new Error("--tenant-id 与 --tenant-name 不能同时使用");
    if (tenantId) return { id: tenantId, name: tenantId, displayName: tenantId };
    if (tenantName) return input.directory.getByName(tenantName);

    const interactive = isInteractive(input.interactive);
    if (!interactive) {
      throw new Error("非交互环境必须通过 --tenant-id 或 --tenant-name 显式指定租户");
    }
    const tenants = await input.directory.listActive();
    if (!tenants.length) throw new Error("租户目录未返回当前启用租户");
    const recent = recentSelectionsForInteractive(input.interactive, input.recent);
    const recentChoices = input.profileName && recent
      ? recent.recentChoices("tenant", input.profileName, tenants, (tenant) => tenant.id)
      : [];
    const selected = await (input.prompt ?? ((choices) => promptTenantChoice({
      choices,
      title: input.promptTitle ?? "[tenant] 当前启用租户：",
      recentChoices,
    })))(tenants);
    if (selected && input.profileName) {
      recent?.recordChoice("tenant", input.profileName, selected.id);
    }
    return selected;
  };
  return input.commandContext
    ? await input.commandContext.decide(
        tenantSelectionDecision,
        [input.profileName ?? input.commandContext.profile.name, input.scope ?? "tenant", input.tenantId ?? "", input.tenantName ?? ""],
        resolve,
      )
    : await resolve();
}
