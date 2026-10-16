import { describe, expect, mock, spyOn, test } from "bun:test";
import type { TenantDirectory } from "@compforge/doctor-plugin";
import { createServiceCatalog } from "@compforge/doctor-plugin";
import { CommandContext, CommandStatus } from "../src/command";
import * as execution from "../src/app/command";
import { createDoctorProgram } from "../src/app/main";
import { tenantCommand } from "../src/collect/tenant/command";
import {
  formatTenantDirectory, queryTenantDirectory, tenantDirectoryCommand,
  type TenantDirectoryInput,
} from "../src/collect/tenant/directory";

const tenant = { id: "t1", name: "alpha", displayName: "Alpha" };
function directory() {
  return {
    listActive: mock(async () => [tenant]),
    getByName: mock(async (_name: string) => tenant),
    getById: mock(async (_id: string) => tenant),
    searchActiveUsers: mock(async (_input: { tenantId: string; query?: string; page: number; pageSize: number }) => ({
      total: 1, users: [{ id: "u1", name: "alice", displayName: "Alice", secret: "private" }],
    })),
  } satisfies TenantDirectory;
}

test("directory queries only call the requested operation and project identity fields", async () => {
  const source = directory();
  expect(await queryTenantDirectory(source, { operation: "list" })).toEqual({ operation: "list", tenants: [tenant] });
  expect(source.getById).not.toHaveBeenCalled();
  await queryTenantDirectory(source, { operation: "get", tenantId: " t1 " });
  expect(source.getById).toHaveBeenCalledWith("t1");
  expect(source.getByName).not.toHaveBeenCalled();
  await queryTenantDirectory(source, { operation: "get", tenantName: " alpha " });
  expect(source.getByName).toHaveBeenCalledWith("alpha");
  expect(source.searchActiveUsers).not.toHaveBeenCalled();
  const users = await queryTenantDirectory(source, { operation: "users", tenantName: "alpha", query: " alice ", page: 2, pageSize: 10 });
  expect(source.searchActiveUsers).toHaveBeenCalledWith({ tenantId: "t1", query: "alice", page: 2, pageSize: 10 });
  expect(users).toEqual({ operation: "users", tenantId: "t1", query: "alice", page: 2, pageSize: 10, total: 1,
    users: [{ id: "u1", name: "alice", displayName: "Alice" }] });
  expect(formatTenantDirectory(users)).toContain("Page: 2 · Page size: 10 · Total: 1");
  expect(formatTenantDirectory(users)).toContain("u1\talice\tAlice");
});

test("user ID scope does not require directory resolution; empty pages remain successful", async () => {
  const search = mock(async () => ({ users: [], total: 0 }));
  const result = await queryTenantDirectory({ ...directory(), searchActiveUsers: search }, { operation: "users", tenantId: "t1" });
  expect(search).toHaveBeenCalledWith({ tenantId: "t1", query: undefined, page: 1, pageSize: 20 });
  expect(result).toMatchObject({ users: [], total: 0 });
});

test("lookup and search failures propagate without fallback", async () => {
  const source = directory();
  source.getById.mockRejectedValue(new Error("not found"));
  await expect(queryTenantDirectory(source, { operation: "get", tenantId: "missing" })).rejects.toThrow("not found");
  expect(source.getByName).not.toHaveBeenCalled();
  source.getByName.mockRejectedValue(new Error("permission denied"));
  await expect(queryTenantDirectory(source, { operation: "users", tenantName: "alpha" })).rejects.toThrow("permission denied");
  expect(source.searchActiveUsers).not.toHaveBeenCalled();
  source.searchActiveUsers.mockRejectedValue(new Error("network failure"));
  await expect(queryTenantDirectory(source, { operation: "users", tenantId: "t1" })).rejects.toThrow("network failure");
});

const invalid: TenantDirectoryInput[] = [
  { operation: "get" }, { operation: "get", tenantId: " " },
  { operation: "get", tenantId: "t1", tenantName: "alpha" },
  { operation: "get", tenantId: "t1", tenantName: "" },
  { operation: "list", tenantId: "t1" },
  { operation: "users", tenantId: "t1", page: 0 },
  { operation: "users", tenantId: "t1", page: 1.5 },
  { operation: "users", tenantId: "t1", pageSize: 101 },
  { operation: "users", tenantId: "t1", pageSize: NaN },
];
for (const input of invalid) test(`invalid directory input fails before external access: ${JSON.stringify(input)}`, async () => {
  const loadPlugin = mock(async () => ({ id: "test", version: "1", services: createServiceCatalog([]) }));
  const context = new CommandContext({}, undefined, { loadPlugin });
  const environment = mock(async () => {});
  context.ensureEnvironment = environment;
  const result = await tenantDirectoryCommand.run(context, input);
  expect(result.status).toBe(CommandStatus.Failed);
  expect(execution.commandExitCode(result)).toBe(2);
  expect(loadPlugin).not.toHaveBeenCalled();
  expect(environment).not.toHaveBeenCalled();
});

describe("tenant CLI routes", () => {
  for (const args of [
    ["tenant", "list"],
    ["tenant", "get", "--tenant-id", "t1", "-f", "json"],
    ["tenant", "--tenant-name", "alpha", "users", "--query", "alice", "--page", "2", "--page-size", "10"],
    ["tenant", "-f", "json", "get", "--tenant-name", "alpha"],
  ]) test(args.join(" "), async () => {
    const run = spyOn(execution, "runCommand").mockResolvedValue(undefined);
    try {
      const program = createDoctorProgram({ name: "ascli", commands: "tenant", commandDefaults: { tenant: { format: "summary" } } });
      await program.parseAsync(args, { from: "user" });
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0]![0].name).toBe(tenantDirectoryCommand.name);
      expect(run.mock.calls[0]![1].format).toBe(args.includes("json") ? "json" : "text");
      if (args.includes("users")) expect(run.mock.calls[0]![2]).toMatchObject({ operation: "users", tenantName: "alpha", query: "alice", page: 2, pageSize: 10 });
    } finally { run.mockRestore(); }
  });
  test("the existing tenant diagnostic keeps its route and format", async () => {
    const run = spyOn(execution, "runCommand").mockResolvedValue(undefined);
    try {
      await createDoctorProgram({ commandDefaults: { tenant: { format: "summary" } } })
        .parseAsync(["tenant", "--tenant-id", "t1"], { from: "user" });
      expect(run.mock.calls[0]![0]).toBe(tenantCommand);
      expect(run.mock.calls[0]![1].format).toBe("summary");
    } finally { run.mockRestore(); }
  });
});


test("directory help shows its output formats without diagnostic delivery options", () => {
  const program = createDoctorProgram({ name: "ascli", commands: "tenant", commandDefaults: { tenant: { format: "summary" } } });
  const get = program.commands.find(command => command.name() === "tenant")!.commands.find(command => command.name() === "get")!;
  const help = get.helpInformation();
  expect(help).toContain("--kubeconfig");
  expect(help).toContain("--tenant-id <id>");
  expect(help).toContain("--tenant-name");
  expect(help).toContain('"text", "json"');
  expect(help).not.toContain('"bundle"');
  expect(help).not.toContain("--output");
});
