import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as execution from "../src/app/command";
import { createDoctorProgram } from "../src/app/main";
import { prepareCommand } from "../src/app/prepare";
import { resolveCollectKubeconfig } from "../src/infra/k8s/context";
import { DOCTOR_CLI_VERSION } from "../src/app/version";
import { extractDistributionArgument, loadDistributionManifest } from "../src/app/distribution";

const roots: string[] = [];
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "doctor-distribution-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runDistribution(root: string, args: string[]) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "run", resolve(import.meta.dir, "fixtures/distribution-cli.ts"), ...args],
    cwd: root,
    env: {
      ...process.env, PATH: `${root}:${process.env.PATH}`, DOCTOR_HOME: root,
      DOCTOR_CONFIG: join(root, "invalid-config.yaml"), NO_COLOR: "1",
      DOCTOR_TEST_KUBECTL_LOG: join(root, "kubectl.log"),
    },
    stdout: "pipe", stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString();
}

describe("Doctor distributions", () => {
  test("Chat receives Host-owned Agent command Distributions", async () => {
    const run = spyOn(execution, "runCommand").mockResolvedValue(undefined);
    try {
      const agentCommands = { samplectl: { name: "samplectl" } };
      const program = createDoctorProgram({}, { agentCommands });
      await program.parseAsync(["chat"], { from: "user" });
      expect(run.mock.calls[0]![2]).toMatchObject({ agentCommands });
    } finally { run.mockRestore(); }
  });
  test("loads a JSON presentation and resolves the embedded exact Plugin", () => {
    const root = temporaryRoot();
    const file = join(root, "distribution.json");
    writeFileSync(file, JSON.stringify({
      name: "fieldctl", version: "3.2.1", plugin: "sample@1.0.0",
      commands: "plugin,inspect", commandDefaults: { inspect: { format: "manifest" } },
    }));
    expect(loadDistributionManifest(file).plugin).toBe("sample@1.0.0");
    expect(runDistribution(root, ["--distribution", file, "--version"])).toBe("fieldctl 3.2.1\n");
    expect(runDistribution(root, ["--distribution", file, "version"]))
      .toStartWith(`fieldctl 3.2.1\ndoctor ${DOCTOR_CLI_VERSION}\nplugin sample@1.0.0\n`);
    const help = runDistribution(root, ["--distribution", file, "--help"]);
    expect(help).toContain("Usage: fieldctl");
    expect(help).not.toMatch(/^  chat /m);
  });

  test("rejects malformed runtime JSON and duplicated selectors", () => {
    const root = temporaryRoot();
    const file = join(root, "invalid.json");
    writeFileSync(file, JSON.stringify({ name: "fieldctl", plugin: "sample", unexpected: true }));
    expect(() => loadDistributionManifest(file)).toThrow("unknown field 'unexpected'");
    expect(() => extractDistributionArgument(["bun", "doctor", "--distribution", file, "--distribution", file]))
      .toThrow("only once");
  });

  test("JSON Help and release version do not require an installed Plugin", () => {
    const root = temporaryRoot();
    const file = join(root, "distribution.json");
    writeFileSync(file, JSON.stringify({ name: "fieldctl", plugin: "absent@1.0.0" }));
    expect(runDistribution(root, ["--distribution", file, "--version"]))
      .toBe(`fieldctl ${DOCTOR_CLI_VERSION}\n`);
    expect(runDistribution(root, ["--distribution", file, "--help"])).toContain("Usage: fieldctl");
  });
  test("retains the upstream identity by default", () => {
    expect(createDoctorProgram().helpInformation()).toContain("Usage: doctor [options] [command]");
  });

  test("customizes root and nested Help without changing Plugin identity", () => {
    const program = createDoctorProgram({ name: "samplectl", description: "Sample diagnostics", commands: "inspect,plugin" });
    const help = program.helpInformation();
    expect(help).toContain("Usage: samplectl [options] [command]");
    expect(help).toContain("Sample diagnostics");
    expect(help).not.toMatch(/^  chat /m);
    for (const command of program.commands) {
      expect(command.helpInformation()).toContain(`Usage: samplectl ${command.name()}`);
      expect(command.helpInformation()).toContain("Global Options:");
      expect(command.helpInformation()).toContain("--kubeconfig <path>");
      expect(command.helpInformation()).toContain("--context <name>");
    }
    const plugin = program.commands.find(command => command.name() === "plugin")!;
    expect(plugin.commands[0]!.helpInformation()).toContain("Usage: samplectl plugin install");
  });

  for (const args of [[], ["-h"], ["help"], ["inspect", "--help"], ["plugin", "install", "--help"]]) {
    test(`Help stays offline: ${args.join(" ") || "bare CLI"}`, () => {
      const root = temporaryRoot();
      writeFileSync(join(root, "invalid-config.yaml"), "profiles: [broken");
      writeFileSync(join(root, "kubectl"), '#!/bin/sh\necho unexpected >> "$DOCTOR_TEST_KUBECTL_LOG"\nexit 99\n', { mode: 0o755 });
      const help = runDistribution(root, args);
      expect(help).toContain("Usage: samplectl");
      expect(help).toContain("--kubeconfig <path>");
      expect(existsSync(join(root, "kubectl.log"))).toBe(false);
    });
  }

  test("Plugin discovery stays offline with an explicit target and invalid profile", () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "invalid-config.yaml"), "profiles: [broken");
    writeFileSync(join(root, "kubectl"), '#!/bin/sh\necho unexpected >> "$DOCTOR_TEST_KUBECTL_LOG"\nexit 99\n', { mode: 0o755 });
    const catalog = JSON.parse(runDistribution(root, ["--kubeconfig", "/missing/config", "plugin", "-f", "json"]));
    expect(catalog.plugins).toMatchObject([{ id: "sample", version: "1.0.0", source: "injected", services: [] }]);
    expect(existsSync(join(root, "kubectl.log"))).toBe(false);
  });
});

describe("global Kubernetes options", () => {
  for (const name of ["inspect", "data", "trace", "log", "metric", "tenant", "collect", "overview", "image", "debug", "install", "mem", "cpu", "http", "net", "store", "db", "model", "mcp", "eval", "perf"]) {
    for (const position of ["before", "after"] as const) {
      test(`${name} forwards target options ${position} the command`, async () => {
        const run = spyOn(execution, "runCommand").mockResolvedValue(undefined);
        try {
          const program = createDoctorProgram();
          const target = ["--kubeconfig", "/explicit/config", "--context", "test-context"];
          const command = name === "collect" ? [name, "--include", "inspect"] : [name];
          await program.parseAsync(position === "before" ? [...target, ...command] : [...command, ...target], { from: "user" });
          expect(run).toHaveBeenCalledTimes(1);
          const [, options, input] = run.mock.calls[0]!;
          expect(options).toMatchObject({ kubeconfig: "/explicit/config", context: "test-context" });
          expect(input).not.toHaveProperty("kubeconfig");
          expect(input).not.toHaveProperty("context");
          expect(input).not.toHaveProperty("debug");
        } finally { run.mockRestore(); }
      });
    }
  }

  test("explicit target wins over the profile through command preparation", () => {
    const root = temporaryRoot();
    const config = join(root, "config.yaml");
    writeFileSync(config, "default_profile: test\nprofiles:\n  test:\n    readonly: true\n    kube:\n      kubeconfig_path: /missing/profile-config\n");
    const context = prepareCommand({ config, kubeconfig: "/explicit/config", context: "chosen" }, false);
    expect(resolveCollectKubeconfig(context.options.environment ?? {}, context.profile))
      .toEqual({ kubeconfig: "/explicit/config", source: "flag" });
    expect(context.options.environment?.context).toBe("chosen");
  });

  test("repeated target flags use the last occurrence across the command boundary", async () => {
    const program = createDoctorProgram();
    const inspect = program.commands.find(command => command.name() === "inspect")!;
    inspect.action((_opts, command) => {
      expect(command.optsWithGlobals()).toMatchObject({ kubeconfig: "/last", context: "last" });
    });
    await program.parseAsync(["--kubeconfig", "/first", "--context", "first", "inspect", "--kubeconfig", "/last", "--context", "last"], { from: "user" });
  });

});

describe("offline distribution versions", () => {
  for (const args of [["-V"], ["--version"], ["version"], ["inspect", "--version"], ["--version", "inspect"]]) {
    for (const target of [[], ["--kubeconfig", "/missing/config", "--context", "chosen"]]) {
      test(`${[...args, ...target].join(" ")} never accesses a target or profile`, () => {
        const root = temporaryRoot();
        writeFileSync(join(root, "invalid-config.yaml"), "profiles: [broken");
        writeFileSync(join(root, "kubectl"), '#!/bin/sh\necho unexpected >> "$DOCTOR_TEST_KUBECTL_LOG"\nexit 99\n', { mode: 0o755 });
        const output = runDistribution(root, [...args, ...target]);
        if (args[0] === "version") {
          expect(output).toStartWith(`samplectl 2.3.4\ndoctor ${DOCTOR_CLI_VERSION}\nplugin sample@1.0.0\n`);
          expect(output).toContain(`os ${process.platform} `);
          expect(output).not.toContain("kubernetes");
        } else {
          expect(output).toBe("samplectl 2.3.4\n");
        }
        expect(existsSync(join(root, "kubectl.log"))).toBe(false);
      });
    }
  }
});
