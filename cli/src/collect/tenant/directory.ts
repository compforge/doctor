import type { TenantDirectory, TenantSummary, UserSummary } from "@compforge/doctor-plugin";
import { CommandInputError, CommandStatus, defineCommand, type CommandInput } from "../../command";
import { commandOptions, type CommandHostOption } from "../../command/options";
import { prepareCommandRequirements } from "../../command/prepare";
import { writeOutput } from "../../terminal/output";
import { openTenantDirectoryAccess } from "./access";
import type { CollectTenantCliOptions } from "./model";

export type TenantDirectoryOperation = "list" | "get" | "users";
export type TenantDirectoryInput = CommandInput & Omit<CollectTenantCliOptions, CommandHostOption> & {
  operation: TenantDirectoryOperation;
  query?: string;
  page?: number;
  pageSize?: number;
};
export type TenantDirectoryResult =
  | { operation: "list"; tenants: TenantSummary[] }
  | { operation: "get"; tenant: TenantSummary }
  | { operation: "users"; tenantId: string; query?: string; page: number; pageSize: number; total: number; users: UserSummary[] };

/** @spec Directory queries require explicit selectors and validate them before preparing any access. */
export function validateTenantDirectoryInput(input: TenantDirectoryInput): void {
  const id = input.tenantId?.trim();
  const name = input.tenantName?.trim();
  if (input.operation === "list") {
    if (input.tenantId !== undefined || input.tenantName !== undefined) throw new CommandInputError("tenant list 不接受租户选择参数");
  } else if ((!!id === !!name) || (input.tenantId !== undefined && input.tenantName !== undefined)) {
    throw new CommandInputError("必须且只能指定一个非空的 --tenant-id 或 --tenant-name");
  }
  if (input.operation === "users") {
    if (!Number.isSafeInteger(input.page ?? 1) || (input.page ?? 1) < 1) throw new CommandInputError("--page 必须是正整数");
    if (!Number.isSafeInteger(input.pageSize ?? 20) || (input.pageSize ?? 20) < 1 || (input.pageSize ?? 20) > 100) {
      throw new CommandInputError("--page-size 必须是 1..100 的整数");
    }
  }
}

function identity(value: TenantSummary | UserSummary): TenantSummary {
  return { id: value.id, name: value.name, displayName: value.displayName };
}

/** @spec get always resolves the requested identity; users with an explicit ID only uses it as search scope. */
export async function queryTenantDirectory(directory: TenantDirectory, input: TenantDirectoryInput): Promise<TenantDirectoryResult> {
  validateTenantDirectoryInput(input);
  if (input.operation === "list") return { operation: "list", tenants: (await directory.listActive()).map(identity) };
  if (input.operation === "get") {
    if (input.tenantName !== undefined) return { operation: "get", tenant: identity(await directory.getByName(input.tenantName.trim())) };
    if (!directory.getById) throw new Error("租户目录不支持按 ID 查询");
    return { operation: "get", tenant: identity(await directory.getById(input.tenantId!.trim())) };
  }
  if (!directory.searchActiveUsers) throw new Error("租户目录未提供 user.search 能力");
  const tenantId = input.tenantId?.trim() ?? (await directory.getByName(input.tenantName!.trim())).id;
  const query = input.query?.trim() || undefined;
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? 20;
  const result = await directory.searchActiveUsers({ tenantId, query, page, pageSize });
  return { operation: "users", tenantId, query, page, pageSize, total: result.total, users: result.users.map(identity) };
}

export function formatTenantDirectory(result: TenantDirectoryResult): string {
  const entries = result.operation === "list" ? result.tenants : result.operation === "get" ? [result.tenant] : result.users;
  const heading = result.operation === "users"
    ? `Tenant: ${result.tenantId} · Page: ${result.page} · Page size: ${result.pageSize} · Total: ${result.total}`
    : `Tenants: ${entries.length}`;
  const cell = (value: string) => value.replace(/[\t\r\n\x1b]/g, " ");
  return [heading, "ID\tNAME\tDISPLAY NAME", ...entries.map(entry => [entry.id, entry.name, entry.displayName].map(cell).join("\t"))].join("\n");
}

/** Directory commands share access preparation with tenant diagnostics but invoke only directory operations. */
export const tenantDirectoryCommand = defineCommand<TenantDirectoryInput, void>({
  name: "doctor tenant directory",
  validate: validateTenantDirectoryInput,
  prepare: async (context, input) => {
    if (!["text", "json"].includes(context.options.format ?? "text")) throw new CommandInputError("租户目录查询仅支持 -f text/json");
    if (context.options.output !== undefined) throw new CommandInputError("租户目录查询输出到终端，请用 shell 重定向保存结果");
    const kinds = input.operation === "list" ? ["tenant.list"]
      : input.operation === "get" ? ["tenant.resolve"]
      : ["user.search", ...(input.tenantName !== undefined ? ["tenant.resolve"] : [])];
    await prepareCommandRequirements(context, {
      plugin: { command: `doctor tenant ${input.operation}`, needs: kinds.map(name => ({
        requirement: "required" as const, capability: { scope: "extension" as const, name }, purpose: "查询租户和用户身份",
      })) },
      environment: { kubernetes: true },
    });
    return input;
  },
  run: async (context, input) => {
    const access = await openTenantDirectoryAccess({ options: { ...input, ...commandOptions(context) }, plugin: context.plugin, commandContext: context });
    if (!access) return { status: CommandStatus.Cancelled, artifacts: [] };
    const result = await queryTenantDirectory(access.directory, input);
    writeOutput(`${context.options.format === "json" ? JSON.stringify(result, null, 2) : formatTenantDirectory(result)}\n`);
    return { status: CommandStatus.Ok, output: undefined, artifacts: [] };
  },
});
