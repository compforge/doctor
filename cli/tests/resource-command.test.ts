import { afterEach, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";
import { createServiceCatalog, withSummary, type PluginDefinition, type ResourceSnapshot, type JsonObject } from "@compforge/doctor-plugin";
import { ToolboxError } from "@compforge/harness-toolbox/errors";
import { CommandContext, CommandStatus } from "../src/command";
import { resourceProviders } from "../src/resource/catalog";
import { collectResources } from "../src/resource/collect";
import { resourceSummary } from "../src/resource/report";
import { resourceCommand, registerResourceCommand } from "../src/resource/command";
import { SerializeContext } from "../src/command/serialization/context";
import { RenderContext } from "../src/report/context";
import { observeResource } from "../src/resource/runtime";
import { enforceKubernetesAccess } from "../src/terminal/kubernetes-access";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const resource = { id: "volumes", kind: "volume", name: "Volumes" };
const source = { resource, relationship: "uses" as const, observe: { access: {}, run: withSummary({ title: "Volumes", fields: [] }, async context => snapshot(context.target.env)) } };
function plugin(): PluginDefinition {
  return { id: "fixture", version: "1.0.0", services: createServiceCatalog([
    { name: "worker", aliases: ["w"], workloads: [], resources: [{ ...source, observe: { ...source.observe } }], component: { name: "w", repository: { forge: { name: "test" }, path: "w" } } },
    { name: "api", workloads: [], resources: [{ ...source, observe: { ...source.observe }, resource: { ...resource, id: "beds", kind: "bed" } }], component: { name: "a", repository: { forge: { name: "test" }, path: "a" } } },
  ]) };
}
function snapshot(environment = "test"): ResourceSnapshot<JsonObject> {
  return { resource, environment, observedAt: "2026-10-23T00:00:00Z", source: "fixture", scope: {},
    coverage: { status: "partial", reason: "First page" },
    instances: [{ ref: { environment, resource: "volumes", id: "v1" }, name: "<script>" }], nextCursor: "opaque" };
}
const query = { maxInstances: 100, maxBytes: 1024 * 1024, timeoutMs: 1000 };
const result = (data = snapshot()) => ({ environment: data.environment, result: { data, summary: { title: "Volumes", fields: [] } } });
function context(active = plugin()) { return new CommandContext({}, undefined, { plugin: active, format: "summary" }); }

test("Resource selector supports kind, Service aliases and exact collection identity", () => {
  expect(resourceProviders(plugin(), { kind: "bed" }).map(p => p.service.name)).toEqual(["api"]);
  expect(resourceProviders(plugin(), { services: ["w", "worker"], kind: "volume" })).toHaveLength(1);
  expect(resourceProviders(plugin(), { kind: "unknown" })).toEqual([]);
  expect(() => resourceProviders(plugin(), { resource: "absent" })).toThrow("未找到");
  expect(() => resourceProviders(plugin(), { services: ["absent"] })).toThrow("Unknown Service");
});

test("Permission denied preserves kind/code and permits a healthy sibling without zero totals", async () => {
  const providers = resourceProviders(plugin(), {});
  const observed = await collectResources(providers, query, { signal: new AbortController().signal,
    observe: async provider => provider.service.name === "api" ? result({ ...snapshot(), resource: provider.binding.resource, instances: [] })
      : Promise.reject(new ToolboxError("secret credential URL", { kind: "permission_denied", code: 403 })) });
  expect(observed.status).toBe(CommandStatus.Partial);
  expect(observed.output.entries[0]!.issue).toEqual({ kind: "permission_denied", code: 403, message: "无权限" });
  expect(observed.output.entries[1]!.snapshot?.totalCount).toBeUndefined();
  expect(JSON.stringify(observed)).not.toContain("secret");
  expect(resourceSummary(observed.output)).toContain("总量：未知");
  expect(observed.output.entries[0]!.snapshot).toBeUndefined();
});

test("Cancellation retains previous observations and stops later sources", async () => {
  const controller = new AbortController();
  const providers = resourceProviders(plugin(), {});
  const call = mock(async () => { controller.abort(); return result(); });
  const observed = await collectResources(providers, query, { signal: controller.signal, observe: call });
  expect(observed.status).toBe(CommandStatus.Cancelled);
  expect(call).toHaveBeenCalledTimes(1);
  expect(observed.output.entries).toHaveLength(1);
});

test("Runtime observation uses host context, disposes it and snapshots JSON before reporting", async () => {
  let disposed = false;
  const active = plugin();
  active.services.services[0]!.resources![0]!.observe.run = withSummary({ title: "Volumes", fields: [] }, async context => {
    context.onDispose(() => { disposed = true; });
    return snapshot(context.target.env);
  });
  const commandContext = context(active);
  const output = await resourceCommand.run(commandContext, { services: ["w"] });
  roots.push(...output.artifacts.map(a => a.path));
  expect(output.status).toBe(CommandStatus.Partial);
  expect(disposed).toBe(true);
  expect(output.output!.entries[0]!.snapshot!.environment).toContain("doctor-host");
  const root = mkdtempSync(join(tmpdir(), "resource-serialized-")); roots.push(root);
  const serialized = await SerializeContext.create(root, resourceCommand, output);
  expect(serialized.failed).toBe(false);
  expect(readFileSync(join(root, "summary.md"), "utf8")).toContain("总量：未知");
  expect(readFileSync(join(root, "summary.md"), "utf8")).not.toContain("<script>");
  const renderer = new RenderContext(serialized.artifacts, "test");
  const report = await renderer.render(resourceCommand, output);
  expect(report.sections[0]?.pages).toHaveLength(1);
  expect(renderer.failures).toEqual([]);
  await commandContext.disposeClients();
});

test("Offline list never calls observers or requires Kubernetes; empty Plugin is clear", async () => {
  const active = plugin();
  const run = mock(async () => { throw new Error("must not execute"); });
  active.services.services[0]!.resources![0]!.observe.run = run;
  const commandContext = context(active);
  const output = await resourceCommand.run(commandContext, { list: true, kind: "volume" });
  roots.push(...output.artifacts.map(a => a.path));
  expect(output.status).toBe(CommandStatus.Ok);
  expect(output.output?.entries).toHaveLength(1);
  expect(run).not.toHaveBeenCalled();
  await commandContext.disposeClients();
  expect(resourceSummary({ mode: "catalog", entries: [] })).toContain("没有声明 Resource");
});

test("CLI declares kind and defaults to summary; invalid budgets/cursor fail before observation", async () => {
  const program = new Command(); registerResourceCommand(program);
  const command = program.commands[0]!;
  expect(command.options.find(o => o.long === "--kind")).toBeDefined();
  expect(command.opts().format).toBe("summary");
  const commandContext = context();
  expect((await resourceCommand.run(commandContext, { maxInstances: 0 })).status).toBe(CommandStatus.Failed);
  expect((await resourceCommand.run(commandContext, { cursor: "x" })).status).toBe(CommandStatus.Failed);
  await commandContext.disposeClients();
});

test("Required Kubernetes preflight denial uses the unified ToolboxError", async () => {
  const need = { rule: { verb: "list", resource: "pods" }, requirement: "required" as const, purpose: "Read pods" };
  const authorization = { evaluate: async () => ({ runnable: false, facts: [{ need, status: "denied" }] }) };
  try { await enforceKubernetesAccess(authorization as never, { command: "resource", needs: [need] }); throw new Error("Expected denial"); }
  catch (error) { expect(error).toBeInstanceOf(ToolboxError); expect((error as ToolboxError).kind).toBe("permission_denied"); }
});

test("Observation deadline and root cancellation reach the provider and dispose its scope", async () => {
  for (const cancelRoot of [false, true]) {
    const active = plugin();
    let signal: AbortSignal | undefined, disposed = false;
    active.services.services[0]!.resources![0]!.observe.run = async context => {
      signal = context.signal;
      context.onDispose(() => { disposed = true; });
      return new Promise((_resolve, reject) => context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true }));
    };
    const commandContext = context(active);
    const pending = observeResource(commandContext, resourceProviders(active, { services: ["w"] })[0]!, { ...query, timeoutMs: cancelRoot ? 1000 : 10 });
    if (cancelRoot) commandContext.cancel(new Error("User cancelled"));
    try { await pending; throw new Error("Expected cancellation"); }
    catch (error) { if (cancelRoot) expect(String(error)).toContain("User cancelled"); else expect((error as ToolboxError).kind).toBe("timeout"); }
    expect(signal?.aborted).toBe(true);
    expect(disposed).toBe(true);
    await commandContext.disposeClients();
  }
});

test("Invalid Plugin snapshots retain invalid_response for every selected source", async () => {
  const providers = resourceProviders(plugin(), {});
  const observed = await collectResources(providers, query, { signal: new AbortController().signal,
    observe: async () => ({ ...result(), environment: "other" }) });
  expect(observed.status).toBe(CommandStatus.Failed);
  expect(observed.output.entries).toHaveLength(2);
  expect(observed.output.entries.every(entry => entry.issue?.kind === "invalid_response")).toBe(true);
});

test("Real CLI routes kind/list and emits resource summary without report files", () => {
  const directory = mkdtempSync(join(tmpdir(), "doctor-resource-cli-")); roots.push(directory);
  for (const args of [["--list", "--kind", "volume"], ["--kind", "volume", "-s", "w"]]) {
    const child = Bun.spawnSync({ cmd: [process.execPath, "run", join(import.meta.dir, "fixtures/resource-cli.ts"), "resource", ...args],
      cwd: directory, env: { ...process.env, DOCTOR_HOME: directory, NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    expect(child.stdout.toString()).toContain("Worker volumes");
    expect(child.stdout.toString()).not.toContain("Evidence Bundle");
    expect(child.stdout.toString()).toContain(args.includes("--list") ? "静态声明" : "总量：0");
  }
});
