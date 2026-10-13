import { describe, expect, spyOn, test } from "bun:test";
import { createServiceCatalog } from "@compforge/doctor-plugin";
import { createDoctorProgram } from "../src/app/main";
import { CommandContext, CommandInputError, CommandStatus, defineCommand, type CommandInput } from "../src/command";
import { forServices } from "../src/command/services";

const serviceCommands = ["plugin", "sample", "health", "store", "db", "s3", "log", "data", "inspect", "net", "metric", "debug", "perf", "eval"];

describe("shared Service selection", () => {
  for (const name of serviceCommands) {
    test(`${name} accepts repeated short/long selectors as one array`, async () => {
      const command = createDoctorProgram().commands.find(command => command.name() === name)!;
      let selected: unknown;
      command.action(() => { selected = command.opts().services; });
      await command.parseAsync(["-s", "api", "--service", "worker", "-s", "api"], { from: "user" });
      expect(selected).toEqual(["api", "worker"]);
      expect(command.helpInformation()).toContain("-s, --service <name>");
      expect(command.options.some(option => option.long === "--services")).toBe(false);
    });
  }

  test("one Service is a one-element array and CSV is rejected", async () => {
    for (const value of ["api", "api,worker", ""]) {
      const command = createDoctorProgram().commands.find(command => command.name() === "plugin")!;
      command.exitOverride().configureOutput({ writeErr: () => {} }).action(() => {});
      if (value === "api") {
        await command.parseAsync(["-s", value], { from: "user" });
        expect(command.opts().services).toEqual(["api"]);
      } else {
        await expect(command.parseAsync(["-s", value], { from: "user" })).rejects.toThrow("每次指定一个 Service");
      }
    }
  });
});

function context() {
  return new CommandContext({}, undefined, { plugin: {
    id: "test", version: "1.0.0",
    services: createServiceCatalog(["api", "worker", "third"].map(name => ({
      name, aliases: [`${name}-alias`], workloads: [],
      component: { name, repository: { forge: { name: "test" }, path: name } },
    }))),
  } });
}

for (const status of [CommandStatus.Failed, CommandStatus.Cancelled] as const) {
  test(`per-Service execution retains prior results and handles ${status}`, async () => {
    const calls: string[] = [];
    const leaf = defineCommand<CommandInput & { service?: string }, string>({
      name: "doctor fixture", prepare: async (_context, input) => input,
      run: async (_context, input) => {
        calls.push(input.service!);
        return input.service === "worker"
          ? { status, reason: "fixture failure", artifacts: [] }
          : { status: CommandStatus.Ok, output: input.service!, artifacts: [] };
      },
    });
    const command = forServices(leaf);
    const ctx = context();
    try {
      const result = await command.run(ctx, { services: ["api", "api-alias", "worker", "third"] });
      expect(calls).toEqual(status === CommandStatus.Cancelled ? ["api", "worker"] : ["api", "worker", "third"]);
      expect(result.status).toBe(status === CommandStatus.Cancelled ? status : CommandStatus.Partial);
      expect(result.output?.services[0]?.result.output).toBe("api");
      expect(result.output?.services[1]?.result).toMatchObject({ status, reason: "fixture failure" });
    } finally { await ctx.disposeClients(); }
  });
}

test("invalid Service names fail before running any selected target", async () => {
  let called = false;
  const command = forServices(defineCommand<CommandInput & { service?: string }, void>({
    name: "doctor fixture", prepare: async (_context, input) => input,
    run: async () => { called = true; return { status: CommandStatus.Ok, output: undefined, artifacts: [] }; },
  }));
  const ctx = context();
  try {
    const result = await command.run(ctx, { services: ["api", "missing"] });
    expect(result.status).toBe(CommandStatus.Failed);
    expect(called).toBe(false);
  } finally { await ctx.disposeClients(); }
});


test("Plugin JSON keeps product and selected Service knowledge at separate levels", async () => {
  const ctx = context();
  let output = "";
  const writer = spyOn(process.stdout, "write").mockImplementation(chunk => { output += String(chunk); return true; });
  try {
    const plugin = { ...ctx.plugin, concepts: "Product concept", workflows: "Product workflow" };
    await createDoctorProgram({ plugin }).parseAsync(["plugin", "-s", "api", "--service", "worker", "-s", "api-alias", "-f", "json"], { from: "user" });
    const selected = JSON.parse(output).plugins[0];
    expect(selected.services.map((service: { name: string }) => service.name)).toEqual(["api", "worker"]);
    expect(selected).not.toHaveProperty("concepts");
    expect(selected.services.every((service: object) => "details" in service)).toBe(true);
    output = "";
    await createDoctorProgram({ plugin }).parseAsync(["plugin", "-f", "json"], { from: "user" });
    const product = JSON.parse(output).plugins[0];
    expect(product.concepts).toBe("Product concept");
    expect(product.services).toHaveLength(3);
    expect(product.services.every((service: object) => !("details" in service))).toBe(true);
  } finally { writer.mockRestore(); await ctx.disposeClients(); }
});

test("input failure without evidence keeps the usage exit code and skips report delivery", async () => {
  const command = forServices(defineCommand<CommandInput & { service?: string }, void>({
    name: "doctor fixture", prepare: async (_context, input) => input,
    run: async () => ({ status: CommandStatus.Failed, error: new CommandInputError("invalid budget"), reason: "invalid budget", artifacts: [] }),
  }));
  const ctx = context();
  try {
    const result = await command.run(ctx, { services: ["api"] });
    expect(commandExitCode(result)).toBe(2);
    expect(result.output).toBeUndefined();
    expect(result.artifacts).toEqual([]);
  } finally { await ctx.disposeClients(); }
});

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SerializeContext } from "../src/command/serialization/context";
import { RenderContext } from "../src/report/context";
import { commandExitCode } from "../src/app/command";
import type { Manifest } from "../src/command/manifest";

test("multiple Services retain independent evidence and report pages", async () => {
  const command = forServices(defineCommand<CommandInput & { service?: string }, string>({
    name: "doctor fixture", prepare: async (_context, input) => input,
    run: async (_context, input) => ({ status: CommandStatus.Ok, output: input.service!, artifacts: [] }),
    serialize: async (writer, result) => ({ files: {
      output: writer.writeJson("output.json", result.output),
      summary: writer.writeText("summary.md", `# Result for ${result.output}\n`),
    } }),
    render: async (_context, result) => ({ title: "Fixture", sections: [{ id: "fixture", title: "Fixture", status: result.status,
      pages: [{ id: "result", title: result.output!, status: result.status }],
    }] }),
  }));
  const ctx = context();
  const root = mkdtempSync(join(tmpdir(), "doctor-services-test-"));
  try {
    const result = await command.run(ctx, { services: ["api", "worker"] });
    const serialized = await SerializeContext.create(root, command, result);
    expect(serialized.failed).toBe(false);
    const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as Manifest;
    expect(manifest.children).toHaveLength(2);
    const contents = manifest.children.map(child => {
      const directory = join(root, dirname(child.manifest));
      const item = JSON.parse(readFileSync(join(root, child.manifest), "utf8")) as Manifest;
      return JSON.parse(readFileSync(join(directory, item.files.output!.path), "utf8"));
    });
    expect(contents).toEqual(["api", "worker"]);
    const summary = readFileSync(join(root, manifest.files.summary!.path), "utf8");
    expect(summary).toContain("[api]");
    expect(summary).toContain("[worker]");
    const report = await new RenderContext([], "test").render(command, result);
    expect(report.sections[0]!.pages.map(page => page.subject?.key)).toEqual(["api", "worker"]);
  } finally { await ctx.disposeClients(); rmSync(root, { recursive: true, force: true }); }
});


test("trace removes the legacy backend Service selector and retains endpoint access", async () => {
  const command = createDoctorProgram().commands.find(command => command.name() === "trace")!;
  command.exitOverride().configureOutput({ writeErr: () => {} }).action(() => {});
  expect(command.options.some(option => option.long === "--service")).toBe(false);
  expect(command.helpInformation()).toContain("--endpoint <url>");
  await expect(command.parseAsync(["--service", "opensearch"], { from: "user" })).rejects.toThrow("unknown option '--service'");
});
