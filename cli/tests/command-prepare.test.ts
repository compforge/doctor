import { prepareCommandRequirements } from "../src/command/prepare";
import { expect, mock, test } from "bun:test";
import { createServiceCatalog, type PluginDefinition } from "@compforge/doctor-plugin";
import {
  CommandContext, CommandInputError, CommandStatus, defineCommand,
  type CommandInput, type CommandResult,
} from "../src/command";
import { onCommandDispose } from "../src/command/execution-scope";
import { commandExitCode } from "../src/app/command";

const ok = <T>(output: T): CommandResult<T> => ({ status: CommandStatus.Ok, output, artifacts: [] });

test("direct and nested calls check requirements in prepare and execute with the typed prepared value", async () => {
  for (const nested of [false, true]) {
    const order: string[] = [];
    const plugin: PluginDefinition = { id: "test", version: "1", services: createServiceCatalog([]) };
    const context = new CommandContext({}, undefined, { loadPlugin: async () => { order.push("plugin"); return plugin; } });
    context.ensureEnvironment = async requirements => { if (requirements.host) order.push("environment"); };
    const child = defineCommand<CommandInput & { name: string }, number, { length: number }>({
      name: "child",
      validate: () => { order.push("validate"); },
      prepare: async (ctx, input) => {
        await prepareCommandRequirements(ctx, { plugin: { command: "child", needs: [] }, environment: { host: true } });
        expect(ctx.plugin).toBe(plugin);
        order.push("prepare");
        ctx.artifacts.add({ command: "child", path: "/tmp/prepare-evidence" });
        onCommandDispose(() => { order.push("dispose"); });
        return { length: input.name.length };
      },
      run: async (_ctx, prepared) => { order.push("run"); return ok(prepared.length); },
    });
    const parent = defineCommand<CommandInput & { name: string }, number>({
      name: "parent", prepare: async (_context, input) => input, run: (ctx, input) => child.run(ctx, input),
    });
    const result = await (nested ? parent : child).run(context, { name: "hello" });
    expect(result.output).toBe(5);
    expect(result.artifacts.map(item => item.path)).toEqual(["/tmp/prepare-evidence"]);
    expect(order).toEqual(["validate", "plugin", "environment", "prepare", "run", "dispose"]);
    expect(child).not.toHaveProperty("prepare");
  }
});

test("invalid input and missing capabilities prevent binding and execution", async () => {
  const prepare = mock(async () => ({ ready: true }));
  const run = mock(async () => ok(1));
  const invalid = defineCommand<CommandInput, number, { ready: boolean }>({
    name: "invalid", validate: () => { throw new CommandInputError("invalid"); }, prepare, run,
  });
  const unavailable = defineCommand<CommandInput, number, { ready: boolean }>({
    name: "unavailable",
    prepare: async (context) => {
      await prepareCommandRequirements(context, { plugin: { command: "unavailable", needs: [{
        capability: { scope: "contribution", name: "inspect" }, requirement: "required", purpose: "test",
      }] } });
      return prepare();
    },
    run,
  });
  expect(commandExitCode(await invalid.run(new CommandContext({}), {}))).toBe(2);
  expect((await unavailable.run(new CommandContext({}), {})).status).toBe(CommandStatus.Failed);
  expect(prepare).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});

test("prepare failure preserves evidence, releases resources and leaves sibling commands runnable", async () => {
  const dispose = mock(() => {});
  const run = mock(async () => ok(1));
  const failed = defineCommand<CommandInput, number, string>({
    name: "failed", prepare: async ctx => {
      onCommandDispose(dispose);
      ctx.artifacts.add({ command: "failed", path: "/tmp/failed-prepare-evidence" });
      throw new CommandInputError("bad selection");
    }, run,
  });
  const context = new CommandContext({});
  const result = await failed.run(context, {});
  expect(result.status).toBe(CommandStatus.Failed);
  expect(commandExitCode(result)).toBe(2);
  expect(result.artifacts.map(item => item.path)).toEqual(["/tmp/failed-prepare-evidence"]);
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(run).not.toHaveBeenCalled();
  const sibling = defineCommand<CommandInput, number>({ name: "sibling", prepare: async (_context, input) => input, run: async () => ok(2) });
  expect((await sibling.run(context, {})).output).toBe(2);
});

test("declined or interrupted preparation skips execution and closes acquired resources", async () => {
  for (const interrupted of [false, true]) {
    const dispose = mock(() => {});
    const run = mock(async () => ok(1));
    const context = new CommandContext({});
    const command = defineCommand<CommandInput, number, string>({
      name: "cancel", prepare: async ctx => {
        onCommandDispose(dispose);
        ctx.artifacts.add({ command: "cancel", path: "/tmp/cancel-prepare-evidence" });
        if (interrupted) { ctx.cancel(); return "ready"; }
        return undefined;
      }, run,
    });
    const result = await command.run(context, {});
    expect(result.status).toBe(CommandStatus.Cancelled);
    expect(result.artifacts).toHaveLength(1);
    expect(context.signal.aborted).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
  }
});

test("concurrent idempotent calls share preparation, execution and cleanup", async () => {
  const dispose = mock(() => {});
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const prepare = mock(async () => { onCommandDispose(dispose); await gate; return { value: 7 }; });
  const run = mock(async (_ctx: CommandContext, prepared: { value: number }) => ok(prepared.value));
  const command = defineCommand<CommandInput, number, { value: number }>({ name: "shared", prepare, run });
  const context = new CommandContext({});
  const input = { idempotencyKey: () => "same" };
  const first = command.run(context, input);
  const second = command.run(context, input);
  release();
  const results = await Promise.all([first, second]);
  expect(results[0]).toBe(results[1]);
  expect((await command.run(context, input))).toBe(results[0]);
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(run).toHaveBeenCalledTimes(1);
  expect(dispose).toHaveBeenCalledTimes(1);
});
