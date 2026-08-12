import { createInterface } from "node:readline/promises";
import type {
  ServiceRequestIdentity,
  TenantDirectory,
  TenantSummary,
  UserDirectorySearch,
  UserDirectorySearchResult,
  UserSummary,
} from "@compforge/doctor-plugin";
import { prepareTerminalInput } from "../terminal/input";
import { terminalStdout } from "../terminal/output";
import { printNumberedChoices } from "../terminal/selection";
import { promptTenantChoice } from "../terminal/tenant-selection";

const USER_PAGE_SIZE = 10;

type UserSearchRequest = Omit<UserDirectorySearch, "tenantId">;
type UserSearch = (input: UserSearchRequest) => Promise<UserDirectorySearchResult>;
type Ask = (question: string) => Promise<string>;

export type UserSearchPromptAction =
  | { kind: "selected"; user: UserSummary }
  | { kind: "search"; query: string }
  | { kind: "next" }
  | { kind: "previous" }
  | { kind: "cancelled" }
  | { kind: "invalid-number" }
  | { kind: "empty" };

function normalized(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result || undefined;
}

export function resolveUserSearchPromptAction(
  users: readonly UserSummary[],
  answer: string,
): UserSearchPromptAction {
  const value = answer.trim();
  if (/^(q|quit)$/i.test(value)) return { kind: "cancelled" };
  if (/^(n|next)$/i.test(value)) return { kind: "next" };
  if (/^(p|prev|previous)$/i.test(value)) return { kind: "previous" };
  if (/^\d+$/.test(value)) {
    const user = users[Number(value) - 1];
    return user ? { kind: "selected", user } : { kind: "invalid-number" };
  }
  if (value) return { kind: "search", query: value };
  return { kind: "empty" };
}

export async function selectUserFromSearch(
  search: UserSearch,
  ask: Ask,
): Promise<UserSummary | undefined> {
  let query: string | undefined;
  let page = 1;
  while (true) {
    if (query === undefined) {
      const answer = (await ask(
        "请输入用户关键词（用户名或展示名，直接回车查看最近用户，q 取消）：",
      )).trim();
      if (/^(q|quit)$/i.test(answer)) return undefined;
      query = answer || "";
      page = 1;
    }

    terminalStdout.info(`[perf] 正在查询${query ? `匹配 '${query}' 的` : ""}启用用户（第 ${page} 页）…\n`);
    const result = await search({
      query: query || undefined,
      page,
      pageSize: USER_PAGE_SIZE,
    });
    const users = result.users;
    if (!users.length) {
      terminalStdout.warning(query
        ? `未找到匹配 '${query}' 的启用用户。\n`
        : "当前租户没有启用用户。\n");
      query = undefined;
      continue;
    }

    const pageCount = Math.max(1, Math.ceil(result.total / USER_PAGE_SIZE));
    printNumberedChoices(
      users,
      `[perf] 用户候选：第 ${page}/${pageCount} 页，共 ${result.total} 个匹配用户`,
      (user) => `${user.name}（${user.displayName}，${user.id}）`,
    );
    const answer = await ask(
      "请选择用户（输入序号或 n/p 后回车；输入新关键词重新搜索；q 取消）：",
    );
    const action = resolveUserSearchPromptAction(users, answer);
    if (action.kind === "selected") return action.user;
    if (action.kind === "cancelled") return undefined;
    if (action.kind === "search") {
      query = action.query;
      page = 1;
      continue;
    }
    if (action.kind === "next") {
      if (page < pageCount) page += 1;
      else terminalStdout.warning("已经是最后一页。\n");
      continue;
    }
    if (action.kind === "previous") {
      if (page > 1) page -= 1;
      else terminalStdout.warning("已经是第一页。\n");
      continue;
    }
    terminalStdout.warning(action.kind === "invalid-number"
      ? "输入的序号不在当前页候选中。\n"
      : "请输入用户序号、翻页命令或新的搜索关键词。\n");
  }
}

async function promptUserChoice(search: UserSearch): Promise<UserSummary | undefined> {
  prepareTerminalInput();
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await selectUserFromSearch(search, (question) => readline.question(question));
  } finally {
    readline.close();
  }
}

export async function resolvePerfRequestIdentity(input: {
  configured: Partial<ServiceRequestIdentity>;
  directory: TenantDirectory;
  promptTenant?: (tenants: readonly TenantSummary[]) => Promise<TenantSummary | undefined>;
  promptUser?: (input: { search: UserSearch }) => Promise<UserSummary | undefined>;
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
    if (!input.directory.searchActiveUsers) {
      throw new Error("Perf Case 需要选择用户，但 tenantDirectory 未提供 searchActiveUsers");
    }
    const search: UserSearch = (request) => input.directory.searchActiveUsers!({
      tenantId,
      ...request,
    });
    const user = await (input.promptUser ?? ((selection) => promptUserChoice(selection.search)))({ search });
    if (!user) return undefined;
    userId = user.id;
  }
  return { tenantId, userId };
}
