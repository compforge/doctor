import type { CaseProduceExtension, ServiceRequestIdentity, TenantDirectory } from "@compforge/doctor-plugin";
import { defineCommandDecision, type CommandContext } from "../command";
import { resolveCaseRequestIdentity } from "./identity";
import { isInteractive } from "../terminal/policy";
import { resolveTenant } from "../terminal/tenant";

const identityDecision = defineCommandDecision<ServiceRequestIdentity | undefined>("case-producer-identity");

export async function resolveCaseProducerTenant(context: CommandContext, extension: CaseProduceExtension,
  input: { tenantId?: string }, directory: TenantDirectory,
  selection: Pick<Parameters<typeof resolveCaseRequestIdentity>[0], "promptTenant" | "interactive"> = {},
): Promise<string | undefined> {
  const tenantId = input.tenantId?.trim() || extension.requestTenant!.configured(context.profile.pluginConfig)?.trim();
  return (await resolveTenant({ tenantId, directory, commandContext: context, scope: "case-identity",
    interactive: selection.interactive, prompt: selection.promptTenant,
    promptTitle: "[case] 选择探测使用的租户：" }))?.id;
}

/** Same configured identity shares one decision, including cancellation or failure, across producers. */
export function resolveCaseProducerIdentity(context: CommandContext, extension: CaseProduceExtension,
  input: { tenantId?: string; userId?: string }, directory: TenantDirectory,
  selection: Pick<Parameters<typeof resolveCaseRequestIdentity>[0], "promptTenant" | "promptUser" | "interactive"> = {},
): Promise<ServiceRequestIdentity | undefined> {
  const configured = extension.requestIdentity!.configured(context.profile.pluginConfig);
  const tenantId = input.tenantId?.trim() || configured.tenantId?.trim();
  // A user belongs to its configured tenant; a CLI tenant override must not reuse a different tenant's user.
  const sameTenant = !configured.tenantId?.trim() || tenantId === configured.tenantId.trim();
  const userId = input.userId?.trim() || (sameTenant ? configured.userId?.trim() : undefined);
  return context.decide(identityDecision, [context.profile.name, tenantId ?? "", userId ?? ""], async () => {
    if (tenantId && userId) return { tenantId, userId };
    if (!isInteractive(selection.interactive)) {
      throw new Error("未执行 Case：缺少租户或真实用户；请设置 --tenant-id / --user-id 或 Plugin Case 身份配置");
    }
    return resolveCaseRequestIdentity({
      ...selection, configured: { tenantId, userId }, directory, commandContext: context,
      commandLabel: "Case", logPrefix: "case",
    });
  });
}
