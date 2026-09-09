import { expect, test } from "bun:test";
import { CommandContext, CommandStatus, defineCommand, type CommandInput } from "../src/command";
import { onCommandDispose } from "../src/command/execution-scope";
import { createInspectInput } from "../src/collect/inspect/command";
import { createTenantInput } from "../src/collect/tenant/command";

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
const keyed = (key: string): CommandInput => ({ idempotencyKey: () => key });

test("concurrent calls share work and cleanup, and completed calls retain status/output/artifacts", async () => {
  const context = new CommandContext({});
  const entered = latch(), finish = latch(), cleanup = latch();
  let runs = 0, disposals = 0;
  const command = defineCommand<CommandInput, string>({
    name: "inspect",
    run: async (ctx) => {
      runs++;
      ctx.artifacts.add("inspect", "/tmp/shared-inspect");
      ctx.artifacts.setReportName("shared-inspect");
      onCommandDispose(async () => { await cleanup.promise; disposals++; });
      entered.release(); await finish.promise;
      return { status: CommandStatus.Partial, output: "missing optional facts", artifacts: [] };
    },
  });
  const first = command.run(context, keyed("environment"));
  await entered.promise;
  let secondReturned = false;
  const second = command.run(context, keyed("environment")).then((result) => { secondReturned = true; return result; });
  finish.release();
  await Bun.sleep(1);
  expect(secondReturned).toBeFalse();
  expect(runs).toBe(1);
  cleanup.release();
  const results = await Promise.all([first, second, command.run(context, keyed("environment"))]);
  expect(disposals).toBe(1);
  for (const result of results) {
    expect(result.status).toBe(CommandStatus.Partial);
    expect(result.output).toBe("missing optional facts");
    expect(result.reportName).toBe("shared-inspect");
    expect(result.artifacts).toEqual([{ command: "inspect", path: "/tmp/shared-inspect" }]);
    context.artifacts.include(result.artifacts);
  }
  expect(context.artifacts.list()).toHaveLength(1);
});

test("keys are scoped by command identity and Context; unkeyed calls always execute", async () => {
  let runs = 0;
  const spec = { name: "same name", run: async () => ({ status: CommandStatus.Ok as const, output: ++runs, artifacts: [] }) };
  const a = defineCommand<CommandInput, number>({ ...spec });
  const b = defineCommand<CommandInput, number>({ ...spec });
  const context = new CommandContext({});
  for (const input of [keyed("a"), keyed("a"), keyed("b"), {}, {}]) await a.run(context, input);
  expect(runs).toBe(4);
  await b.run(context, keyed("a"));
  await a.run(new CommandContext({}), keyed("a"));
  expect(runs).toBe(6);
});

test("failed execution shares its evidence; validation still runs before reusing a key", async () => {
  let runs = 0;
  const command = defineCommand<CommandInput & { valid: boolean }, void>({
    name: "tenant",
    validate: (input) => { if (!input.valid) throw new Error("invalid input"); },
    run: async (ctx) => { runs++; ctx.artifacts.add("tenant", "/tmp/failed-tenant"); throw new Error("access denied"); },
  });
  const context = new CommandContext({});
  const input = { ...keyed("tenant"), valid: true };
  const first = await command.run(context, input);
  const second = await command.run(context, input);
  expect(first.status).toBe(CommandStatus.Failed);
  expect(second).toEqual(first);
  expect(second.artifacts).toHaveLength(1);
  const invalid = await command.run(context, { ...input, valid: false });
  expect("reason" in invalid && invalid.reason).toBe("invalid input");
  expect(runs).toBe(1);
});

test("cancellation reaches shared work and waiters, drains cleanup, and overrides cached success", async () => {
  const entered = latch();
  const context = new CommandContext({});
  let runs = 0, disposed = 0;
  const command = defineCommand<CommandInput, void>({
    name: "inspect",
    run: async (ctx) => {
      runs++; ctx.artifacts.add("inspect", "/tmp/cancelled-inspect");
      onCommandDispose(async () => { await Bun.sleep(1); disposed++; });
      const aborted = new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
      entered.release(); await aborted;
      return { status: CommandStatus.Ok, output: undefined, artifacts: [] };
    },
  });
  const first = command.run(context, keyed("key"));
  await entered.promise;
  const second = command.run(context, keyed("key"));
  await Bun.sleep(1);
  context.cancel();
  const results = await Promise.all([first, second]);
  expect(runs).toBe(1); expect(disposed).toBe(1);
  for (const result of results) { expect(result.status).toBe(CommandStatus.Cancelled); expect(result.artifacts).toHaveLength(1); }
  const doneContext = new CommandContext({});
  const done = defineCommand<CommandInput, void>({ name: "done", run: async () => ({ status: CommandStatus.Ok, output: undefined, artifacts: [] }) });
  await done.run(doneContext, keyed("key"));
  doneContext.cancel();
  expect((await done.run(doneContext, keyed("key"))).status).toBe(CommandStatus.Cancelled);
});

test("Inspect and Tenant input identities change with collection scope, not caller biz-id", () => {
  const inspect = createInspectInput({ namespace: "ns", services: "api", dependencies: false });
  expect(inspect.idempotencyKey!()).toBe(createInspectInput({ namespace: "ns", services: "api", dependencies: false }).idempotencyKey!());
  for (const change of [{ namespace: "other" }, { services: "worker" }, { dependencies: true }, { deploymentConfig: true }]) {
    expect(createInspectInput({ ...inspect, ...change }).idempotencyKey!()).not.toBe(inspect.idempotencyKey!());
  }
  const tenant = createTenantInput({ namespace: "ns", tenantId: "one" });
  for (const change of [{ namespace: "other" }, { tenantId: "two" }, { tenantName: "another" }, { tenantDirectoryService: "directory" }, { tenantDirectoryPort: "8080" }]) {
    expect(createTenantInput({ ...tenant, ...change }).idempotencyKey!()).not.toBe(tenant.idempotencyKey!());
  }
});
