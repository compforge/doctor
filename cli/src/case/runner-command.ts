import type { Case } from "@compforge/spec-case/model";
import type { CaseRunnerFactory, CommandInvocation, TenantDirectory } from "@compforge/doctor-plugin";
import type { CommandContext } from "../command";
import { resolveTenant } from "../terminal/tenant";
import { resolveCaseRequestIdentity } from "./identity";
import type { CaseDataset } from "./params";

/** Select command-scoped identity once. CSV values stay scoped to a single request. */
export async function prepareRunnerCommand(factory: CaseRunnerFactory, cases: readonly Case[], rows: CaseDataset,
  context: CommandContext, directory: TenantDirectory, label: string): Promise<CommandInvocation | undefined> {
  const requirement = factory.requestIdentity;
  const configured = requirement?.configured(context.profile.pluginConfig) ?? {};
  const needsPair = requirement && cases.some(item => requirement.requiredFor?.(item) ?? true);
  const needs = new Set(cases.flatMap(item => Object.entries(item.params ?? {})
    .filter(([name, param]) => !Object.hasOwn(rows[0] ?? {}, name) && param.default === undefined)
    .map(([, param]) => param.source)));
  if (needsPair || (needs.has("command.user_id") && !configured.userId)) {
    return resolveCaseRequestIdentity({ configured, directory, commandContext: context,
      commandLabel: label, logPrefix: label.toLowerCase() });
  }
  if (needs.has("command.tenant_id") && !configured.tenantId) {
    const tenant = await resolveTenant({ directory, commandContext: context, profileName: context.profile.name,
      scope: "case-identity", promptTitle: `[${label}] 选择请求租户：` });
    return tenant ? { ...configured, tenantId: tenant.id } : undefined;
  }
  return configured;
}

/** Supply the original runner option for already-distributed plugins. */
export function runnerIdentity(command: CommandInvocation) {
  if (command.tenantId && command.userId) return { tenantId: command.tenantId, userId: command.userId };
}
