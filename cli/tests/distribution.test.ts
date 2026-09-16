import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as execution from "../src/app/command";
import { createDoctorProgram } from "../src/app/main";
import { prepareCommand } from "../src/app/prepare";
import { resolveCollectKubeconfig } from "../src/infra/k8s/context";

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
  for (const name of ["inspect", "data", "trace", "log", "metric", "tenant", "collect", "overview", "image", "debug", "install", "mem", "cpu", "http", "net", "store", "model", "mcp", "eval", "perf"]) {
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

  for (const args of [["-V"], ["version"], ["inspect", "--version"]]) {
    test(`${args.join(" ")} probes only the explicitly selected Kubernetes target`, () => {
      const root = temporaryRoot();
      writeFileSync(join(root, "kubectl"), '#!/bin/sh\nprintf "%s\\n" "$@" >> "$DOCTOR_TEST_KUBECTL_LOG"\nprintf \'{"gitVersion":"v1.32.3"}\\n\'\n', { mode: 0o755 });
      const output = runDistribution(root, [...args, "--kubeconfig", "/explicit/config", "--context", "chosen"]);
      expect(output).toContain("doctor ");
      expect(output).toContain("plugin sample@1.0.0");
      expect(output).toContain("kubernetes v1.32.3");
      const calls = readFileSync(join(root, "kubectl.log"), "utf8");
      expect(calls.match(/--kubeconfig\n\/explicit\/config/g)).toHaveLength(1);
      expect(calls.match(/--context\nchosen/g)).toHaveLength(1);
    });
  }
});
