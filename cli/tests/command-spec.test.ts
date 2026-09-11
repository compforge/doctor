import { createServiceCatalog, type PluginDefinition } from "@compforge/doctor-plugin";
import type { Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import { expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandExitCode, runCommand } from "../src/app/command";
import { createCollectCommand } from "../src/collect/composite";
import {
  CommandContext, CommandInputError, CommandStatus, commandOutcome, defineCommand,
  type CommandInput, type CommandResult, type EnvironmentRequirements,
} from "../src/command";
import { onCommandDispose } from "../src/command/execution-scope";
import { createPluginContext } from "../src/plugin/context";
import { composeReports } from "../src/report/model";
import { readReport } from "./report-fixture";

const plugin: PluginDefinition = { id: "test", version: "1.0.0", services: createServiceCatalog([]) };
const makeContext = () => new CommandContext({}, undefined, { plugin });
const ok = <T>(output: T): CommandResult<T> => ({ status: CommandStatus.Ok, output, artifacts: [] });
const executor: Executor = {
  run: async () => { throw new Error("Unexpected external access"); },
  exec: async () => { throw new Error("Unexpected external access"); },
};
function managed() {
  return createPluginContext(executor, { namespace: "test" }, {
    env: "test", service: { name: "api" }, capability: { access: {} },
  });
}

test("validation precedes Plugin loading and environment preparation for direct and nested runs", async () => {
  const load = mock(async () => plugin);
  const context = new CommandContext({}, undefined, { loadPlugin: load });
  const environment = mock(async (_requirements: EnvironmentRequirements) => {});
  context.ensureEnvironment = environment;
  const work = mock(async () => ok(1));
  const child = defineCommand<CommandInput & { value: number }, number>({
    name: "child", environment: { kubernetes: true }, plugin: { command: "child", needs: [] },
    validate: () => { throw new CommandInputError("invalid input"); }, run: work,
  });
  const parent = defineCommand<CommandInput & { value: number }, number>({ name: "parent", run: (ctx, input) => child.run(ctx, input) });
  for (const spec of [child, parent]) {
    const result = await spec.run(context, { value: 1 });
    expect(result.status).toBe(CommandStatus.Failed);
    expect(commandExitCode(result)).toBe(2);
  }
  expect(load).not.toHaveBeenCalled();
  expect(work).not.toHaveBeenCalled();
  expect(environment.mock.calls.every(([requirements]) => !requirements.kubernetes)).toBe(true);
});

test("Plugin loading and config validation are shared across sibling calls", async () => {
  const validateConfig = mock(() => {});
  const load = mock(async () => ({ ...plugin, validateConfig }));
  const context = new CommandContext({}, undefined, { loadPlugin: load });
  const command = defineCommand<CommandInput, string>({
    name: "child", plugin: { command: "child", needs: [] },
    run: async (ctx) => ok(ctx.plugin.id),
  });
  const results = await Promise.all([command.run(context, {}), command.run(context, {})]);
  expect(results.map((result) => result.output)).toEqual(["test", "test"]);
  expect(load).toHaveBeenCalledTimes(1);
  expect(validateConfig).toHaveBeenCalledTimes(1);
});

test("missing child capability does not veto independent collectors", async () => {
  const context = makeContext();
  const work = mock(async () => ok(undefined));
  const unavailable = defineCommand<CommandInput, void>({
    name: "trace", environment: { kubernetes: true },
    plugin: { command: "trace", needs: [{ requirement: "required", purpose: "test",
      capability: { scope: "service", name: "traceId" } }] }, run: work,
  });
  const calls: string[] = [];
  const collect = createCollectCommand(async (kind) => {
    calls.push(kind);
    return kind === "trace" ? unavailable.run(context, {}) : ok(undefined);
  });
  const result = await collect.run(context, { bizIds: ["id"], kinds: ["trace", "data"] });
  expect(result.status).toBe(CommandStatus.Partial);
  expect(commandExitCode(result)).toBe(0);
  expect(calls).toEqual(["trace", "data"]);
  expect(work).not.toHaveBeenCalled();
  for (const artifact of result.artifacts) rmSync(artifact.path, { force: true, recursive: true });
});

test("parallel and repeated child calls return only their own artifacts and report names", async () => {
  const context = makeContext();
  let release!: () => void;
  const bothStarted = new Promise<void>((resolve) => { release = resolve; });
  let started = 0;
  const child = defineCommand<CommandInput & { id: string }, string>({ name: "trace", run: async (ctx, { id }) => {
    ctx.artifacts.setReportName(id);
    ctx.artifacts.add({ command: "trace", path: `/tmp/${id}` });
    if (++started === 2) release();
    await bothStarted;
    expect(ctx.artifacts.list()).toEqual([{ id: expect.any(String), command: "trace", path: `/tmp/${id}` }]);
    return ok(id);
  } });
  const parent = defineCommand<CommandInput, string[]>({ name: "overview", run: async (ctx) => {
    ctx.artifacts.setReportName("overview");
    const children = await Promise.all([child.run(ctx, { id: "first" }), child.run(ctx, { id: "second" })]);
    expect(ctx.artifacts.list()).toEqual([]);
    for (const result of children) ctx.artifacts.add(result.artifacts);
    expect(ctx.artifacts.reportName()).toBe("overview");
    return ok(children.map((result) => result.reportName!));
  } });
  const result = await parent.run(context, {});
  expect(result.status).toBe(CommandStatus.Ok);
  expect(result.output).toEqual(["first", "second"]);
  expect(result.reportName).toBe("overview");
  expect(result.artifacts.map((artifact) => artifact.path)).toEqual(["/tmp/first", "/tmp/second"]);
  const again = await child.run(context, { id: "third" });
  expect(again.artifacts).toEqual([{ id: expect.any(String), command: "trace", path: "/tmp/third" }]);
});

test("cancelled collector stops subsequent calls and preserves completed evidence", async () => {
  const context = makeContext();
  const calls: string[] = [];
  const root = mkdtempSync(join(tmpdir(), "doctor-command-cancel-"));
  const path = join(root, "evidence.txt");
  writeFileSync(path, "captured");
  const collect = createCollectCommand(async (kind) => {
    calls.push(kind);
    return kind === "data" ? { ...ok(undefined), artifacts: [context.artifacts.add({ command: kind, path })] } : commandOutcome(130);
  });
  try {
    const result = await collect.run(context, { bizIds: ["id"], kinds: ["data", "trace", "log"] });
    expect(result.status).toBe(CommandStatus.Cancelled);
    expect(commandExitCode(result)).toBe(130);
    expect(context.signal.aborted).toBe(true);
    expect(calls).toEqual(["data", "trace"]);
    expect(result.artifacts.some((artifact) => artifact.path === path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("captured");
    for (const artifact of result.artifacts.filter((item) => item.command === "collect")) rmSync(artifact.path, { force: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("child cleanup disposes its Plugin contexts once and leaves the parent's resources alive", async () => {
  const cleanup = mock(() => {});
  const child = defineCommand<CommandInput, void>({ name: "child", run: async () => {
    const ctx = managed();
    ctx.onDispose(cleanup);
    await ctx.dispose();
    return ok(undefined);
  } });
  const parent = defineCommand<CommandInput, void>({ name: "parent", run: async (ctx) => {
    const parentPlugin = managed();
    await child.run(ctx, {});
    expect(parentPlugin.signal.aborted).toBe(false);
    expect(ctx.signal.aborted).toBe(false);
    parentPlugin.onDispose(cleanup);
    return ok(undefined);
  } });
  expect((await parent.run(makeContext(), {})).status).toBe(CommandStatus.Ok);
  expect(cleanup).toHaveBeenCalledTimes(2);
});

test("parent cancellation reaches active Plugin calls and cleanup retains returned artifacts", async () => {
  const context = makeContext();
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const cleanup = mock(() => {});
  const child = defineCommand<CommandInput, void>({ name: "child", run: async () => {
    const pluginContext = managed();
    pluginContext.onDispose(cleanup);
    ready();
    await new Promise<void>((resolve) => pluginContext.signal.addEventListener("abort", () => resolve(), { once: true }));
    return { ...ok(undefined), artifacts: [context.artifacts.add({ command: "child", path: "/tmp/before-cancel" })] };
  } });
  const pending = child.run(context, {});
  await started;
  context.cancel();
  const result = await pending;
  expect(result.status).toBe(CommandStatus.Cancelled);
  expect(result.artifacts).toHaveLength(1);
  expect(cleanup).toHaveBeenCalledTimes(1);
});

test("cleanup failures preserve staged artifacts and surface failure", async () => {
  const command = defineCommand<CommandInput, void>({ name: "cleanup", run: async (ctx) => {
    onCommandDispose(() => { throw new Error("cannot close"); });
    return { ...ok(undefined), artifacts: [ctx.artifacts.add({ command: "cleanup", path: "/tmp/retained" })] };
  } });
  const result = await command.run(makeContext(), {});
  expect(result.status).toBe(CommandStatus.Failed);
  expect(result.artifacts).toEqual([{ id: expect.any(String), command: "cleanup", path: "/tmp/retained" }]);
  expect("reason" in result && result.reason).toContain("cleanup failed");
});

test("only the root delivers and cleans child artifacts, including partial results", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-command-delivery-"));
  const output = join(root, "report.html");
  const previousExit = process.exitCode;
  let resourceClosed = false;
  const child = defineCommand<CommandInput & { id: string }, void>({ name: "trace",
    render: async (renderer, result) => {
      expect(resourceClosed).toBeTrue();
      return { title: "Trace", sections: [{ id: "trace", title: "Trace", status: result.status,
        pages: result.artifacts.map(artifact => {
          renderer.write(artifact, renderer.read(artifact, "evidence.html"));
          return renderer.page(artifact, { title: "Trace", status: result.status });
        }),
      }] };
    }, run: async (ctx, { id }) => {
    expect(existsSync(output)).toBe(false);
    const path = join(root, id);
    mkdirSync(path);
    writeFileSync(join(path, "evidence.html"), `<html>${id}</html>`);
    ctx.artifacts.add({ command: "trace", path });
    return { status: CommandStatus.Partial, output: undefined, artifacts: [] };
  } });
  const children: CommandResult<void>[] = [];
  const parent = defineCommand<CommandInput, void>({ name: "overview",
    render: async renderer => composeReports("Overview", await Promise.all(children.map(result => renderer.render(child, result)))),
    run: async (ctx) => {
    await ctx.clients.get({ key: "shared", createClient: () => ({
      initialize: async () => {},
      dispose: async () => {
        expect(existsSync(join(root, "first", "evidence.html"))).toBe(true);
        expect(existsSync(join(root, "second", "evidence.html"))).toBe(true);
        resourceClosed = true;
      },
    }) });
    for (const id of ["first", "second"]) {
      const result = await child.run(ctx, { id });
      expect(result.status).toBe(CommandStatus.Partial);
      expect(existsSync(result.artifacts[0]!.path)).toBe(true);
      ctx.artifacts.add(result.artifacts);
      children.push(result);
      expect(existsSync(join(result.artifacts[0]!.path, "report.html"))).toBeFalse();
    }
    return { status: CommandStatus.Partial, output: undefined, artifacts: [] };
  } });
  try {
    await runCommand(parent, { config: join(root, "absent.yaml"), output, format: "html" }, {}, { printProfile: false });
    expect(process.exitCode).toBe(0);
    expect(resourceClosed).toBe(true);
    const report = readReport(readFileSync(output, "utf8")).pages;
    expect(report).toContain("first");
    expect(report).toContain("second");
    expect(existsSync(join(root, "first"))).toBe(false);
    expect(existsSync(join(root, "second"))).toBe(false);
  } finally {
    process.exitCode = previousExit;
    rmSync(root, { recursive: true, force: true });
  }
});


test("finalize cleanup failure still delivers captured evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-finalize-failure-"));
  const output = join(root, "report.html");
  const previousExit = process.exitCode;
  const command = defineCommand<CommandInput, void>({ name: "overview",
    render: async (renderer, result) => ({ title: "Overview", sections: [{ id: "overview", title: "Overview", status: result.status,
      pages: result.artifacts.map(artifact => renderer.page(artifact, { title: "Overview", status: result.status })),
    }] }),
    run: async ctx => {
    await ctx.clients.get({ key: "broken-close", createClient: () => ({
      initialize: async () => {}, dispose: async () => { throw new Error("close failed"); },
    }) });
    const artifact = join(root, "evidence");
    mkdirSync(artifact);
    writeFileSync(join(artifact, "report.html"), "<html>captured evidence</html>");
    ctx.artifacts.add({ command: "overview", path: artifact });
    return ok(undefined);
  } });
  try {
    await runCommand(command, { config: join(root, "absent.yaml"), output, format: "html" }, {}, { printProfile: false });
    expect(process.exitCode).toBe(1);
    expect(readReport(readFileSync(output, "utf8")).pages).toContain("captured evidence");
  } finally { process.exitCode = previousExit; rmSync(root, { recursive: true, force: true }); }
});
