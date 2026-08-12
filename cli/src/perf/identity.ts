import type {
  ServiceRequestIdentity,
  TenantDirectory,
  TenantSummary,
  UserSummary,
} from "@compforge/doctor-plugin";
import {
  printNumberedChoices,
  promptSearchableChoice,
  type SearchableChoiceResolution,
} from "../terminal/selection";
import { promptTenantChoice } from "../terminal/tenant-selection";

const USER_PREVIEW_LIMIT = 10;

function normalized(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result || undefined;
}

function userSearchKeys(user: UserSummary): string[] {
  return [user.name, user.displayName, user.id].map((value) => value.toLowerCase());
}

export function resolveUserPromptChoice(
  users: readonly UserSummary[],
  answer: string,
  numberedUsers: readonly UserSummary[],
): SearchableChoiceResolution<UserSummary, UserSummary> {
  const query = answer.trim().toLowerCase();
  if (/^\d+$/.test(query)) {
    const selected = numberedUsers[Number(query) - 1];
    return selected ? { kind: "selected", value: selected } : { kind: "invalid-number" };
  }
  const exact = users.filter((user) => userSearchKeys(user).includes(query));
  if (exact.length === 1) return { kind: "selected", value: exact[0]! };
  if (exact.length > 1) return { kind: "ambiguous", matches: exact };
  const matches = users.filter((user) => userSearchKeys(user).some((key) => key.includes(query)));
  if (matches.length === 1) return { kind: "selected", value: matches[0]! };
  if (matches.length > 1) return { kind: "ambiguous", matches };
  return { kind: "not-found" };
}

async function promptUserChoice(users: readonly UserSummary[]): Promise<UserSummary | undefined> {
  const printUsers = (items: readonly UserSummary[], title: string): void => printNumberedChoices(
    items,
    title,
    (user) => `${user.name}（${user.displayName}，${user.id}）`,
  );
  const preview = users.length <= USER_PREVIEW_LIMIT ? users : [];
  if (preview.length) printUsers(preview, "[perf] 当前租户的启用用户：");
  return promptSearchableChoice({
    choices: users,
    numberedChoices: preview,
    question: (listed) => users.length > USER_PREVIEW_LIMIT
      ? `当前用户候选 ${users.length} 个，请输入用户关键词（用户名、展示名或 ID）${listed ? "或列表序号" : ""}（q 取消）：`
      : "请选择用户（序号、用户名、展示名或 ID，q 取消）：",
    resolve: (answer, numberedChoices) => resolveUserPromptChoice(users, answer, numberedChoices),
    printChoices: printUsers,
    ambiguousTitle: (answer) => `[perf] 匹配 '${answer}' 的用户：`,
    notFoundMessage: (answer) => `未找到匹配 '${answer}' 的用户。`,
    invalidNumberMessage: "输入的序号不在当前候选中。",
    emptyMessage: "请输入用户关键词或列表序号。",
  });
}

export async function resolvePerfRequestIdentity(input: {
  configured: Partial<ServiceRequestIdentity>;
  directory: TenantDirectory;
  promptTenant?: (tenants: readonly TenantSummary[]) => Promise<TenantSummary | undefined>;
  promptUser?: (users: readonly UserSummary[]) => Promise<UserSummary | undefined>;
}): Promise<ServiceRequestIdentity | undefined> {
  let tenantId = normalized(input.configured.tenantId);
  let userId = normalized(input.configured.userId);
  if (!tenantId) {
    const tenants = await input.directory.listActive();
    if (!tenants.length) throw new Error("租户目录未返回当前启用租户");
    const tenant = await (input.promptTenant ?? ((choices) => promptTenantChoice({
      choices,
      title: "[perf] 当前启用租户：",
    })))(tenants);
    if (!tenant) return undefined;
    tenantId = tenant.id;
  }
  if (!userId) {
    if (!input.directory.listActiveUsers) {
      throw new Error("Perf Case 需要选择用户，但 tenantDirectory 未提供 listActiveUsers");
    }
    const users = await input.directory.listActiveUsers(tenantId);
    if (!users.length) throw new Error(`租户 ${tenantId} 没有启用用户`);
    const user = await (input.promptUser ?? promptUserChoice)(users);
    if (!user) return undefined;
    userId = user.id;
  }
  return { tenantId, userId };
}
