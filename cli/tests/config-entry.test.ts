import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { createDoctorProgram } from "../src/app/main";
import * as execution from "../src/app/command";
import { resolveConfigPath, resolveWorkingProfile, resolveWorkingProfileName, runProfile } from "../src/app/profile";
import { runInit } from "../src/app/init";
import { prepareCommand } from "../src/app/prepare";
import { commandOptions, domainInput } from "../src/command/options";
import { commandOptionsWithSources, withoutShadowedDefaults } from "../src/app/option-sources";
import { resolveCollectNamespace } from "../src/infra/k8s/context";
import { resolveProfileRegistryCredentials } from "../src/app/registry-auth";
import { loadConfig } from "../src/app/config/config";

const originalConfig = process.env.DOCTOR_CONFIG;
const roots: string[] = [];
afterEach(() => {
  if (originalConfig === undefined) delete process.env.DOCTOR_CONFIG;
  else process.env.DOCTOR_CONFIG = originalConfig;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function configFile(content: string): string {
  const root = mkdtempSync(join(tmpdir(), "doctor-config-entry-"));
  roots.push(root);
  const path = join(root, "config.yaml");
  writeFileSync(path, content);
  return path;
}

describe("empty configuration entry", () => {
  test("does not load an environment override or synthesize a kubeconfig", () => {
    process.env.DOCTOR_CONFIG = configFile("profiles: [invalid");
    expect(resolveConfigPath("")).toBe("");
    expect(loadConfig("")).toEqual({ profiles: {} });
    expect(resolveWorkingProfile({ config: "" })).toEqual({
      name: "", configPath: "", profile: { readonly: true },
    });
    expect(resolveWorkingProfileName({ config: "" })).toBe("");
    const context = prepareCommand({ config: "" }, false);
    expect(context.profile.pluginConfig).toEqual({});
    const options = commandOptions(context);
    expect(options.config).toBe("");
    expect(options.profile).toBeUndefined();
    expect(context.profile.value.kube?.kubeconfig_path).toBeUndefined();
    expect(resolveCollectNamespace(options, context.profile)).toEqual({ namespace: "default", source: "default" });
    expect(resolveProfileRegistryCredentials("example.org/app", options)).toBeUndefined();
    expect(() => resolveWorkingProfile({})).toThrow();
  });

  test("rejects profile selection, resume, and configuration writers", async () => {
    expect(() => resolveWorkingProfile({ config: "", profile: "dev" })).toThrow("--profile");
    expect(() => resolveWorkingProfileName({ config: "", resume: true })).toThrow("--resume");
    await expect(runProfile(undefined, { config: "" })).rejects.toThrow("unavailable");
    await expect(runInit({ config: "" })).rejects.toThrow("unavailable");
  });

  test("keeps ordinary configuration path resolution unchanged", () => {
    delete process.env.DOCTOR_CONFIG;
    expect(resolveConfigPath()).toMatch(/\.doctor\/config\.yaml$/);
    process.env.DOCTOR_CONFIG = "/environment/config";
    expect(resolveConfigPath()).toBe("/environment/config");
    expect(resolveConfigPath("/explicit/config")).toBe("/explicit/config");
  });
});

describe("distribution root defaults and configuration Help", () => {
  for (const args of [["--config=", "--help"], ["--help", "--config="], ["inspect", "--config=", "--help"], ["--config=", "help", "inspect"]]) {
    test(args.join(" "), async () => {
      const program = createDoctorProgram();
      let help = "";
      const capture = (command: Command): void => {
        command.exitOverride().configureOutput({ writeOut: text => { help += text; } });
        for (const child of command.commands) capture(child);
      };
      capture(program);
      if (args.includes("help")) await program.parseAsync(args, { from: "user" });
      else await expect(program.parseAsync(args, { from: "user" })).rejects.toMatchObject({ exitCode: 0 });
      expect(help).not.toContain("--profile");
      expect(help).not.toMatch(/^  (init|profile)\b/m);
      expect(help).toContain("--kubeconfig");
      expect(help).toContain("--namespace");
    });
  }

  test("defaults change Help per instance; ordinary Doctor keeps profile", () => {
    const distribution = createDoctorProgram({ optionDefaults: { config: "" } });
    expect(distribution.helpInformation()).not.toMatch(/^  profile\b/m);
    expect(distribution.commands.find(command => command.name() === "inspect")!.helpInformation()).not.toContain("--profile");
    expect(createDoctorProgram().helpInformation()).toMatch(/^  profile\b/m);
    expect(createDoctorProgram().commands.find(command => command.name() === "inspect")!.helpInformation()).toContain("--profile");
    expect(() => createDoctorProgram({ optionDefaults: { missing: "" } })).toThrow("unknown option");
  });

  for (const before of [true, false]) {
    test("explicit root inputs override defaults " + (before ? "before" : "after") + " command", async () => {
      const run = spyOn(execution, "runCommand").mockResolvedValue(undefined);
      try {
        const program = createDoctorProgram({ optionDefaults: { config: "" } });
        const flags = ["--config", "/explicit/config", "-n", "app", "--kubeconfig", "/target/config"];
        await program.parseAsync(before ? [...flags, "inspect"] : ["inspect", ...flags], { from: "user" });
        expect(run.mock.calls[0]![1]).toMatchObject({ config: "/explicit/config", namespace: "app", kubeconfig: "/target/config" });
      } finally { run.mockRestore(); }
    });
  }

  test("namespace default stays below profile; empty config keeps default and explicit target", async () => {
    const path = configFile("profiles:\n  dev:\n    readonly: true\n    namespace: saved\n");
    const run = spyOn(execution, "runCommand").mockResolvedValue(undefined);
    try {
      for (const config of [path, ""]) {
        const program = createDoctorProgram({ optionDefaults: { config } });
        await program.parseAsync(["inspect", "--kubeconfig", "/explicit/target"], { from: "user" });
        const options = run.mock.calls.at(-1)![1];
        // The domain owns the fallback so absent flags retain profile/interactive selection semantics.
        expect(options.namespace).toBeUndefined();
        const context = prepareCommand(options, false);
        const input = withoutShadowedDefaults(domainInput(options), context.profile.value);
        expect(resolveCollectNamespace(input, context.profile).namespace).toBe(config ? "saved" : "default");
        expect(context.options.environment?.kubeconfig).toBe("/explicit/target");
      }
    } finally { run.mockRestore(); }
  });

  test("root config does not capture container -c; legacy config -c overrides distribution defaults", async () => {
    const run = spyOn(execution, "runCommand").mockResolvedValue(undefined);
    try {
      const program = createDoctorProgram({ optionDefaults: { config: "" } });
      await program.parseAsync(["mem", "-c", "worker"], { from: "user" });
      expect(run.mock.calls[0]![1]).toMatchObject({ config: "", container: "worker" });
    } finally { run.mockRestore(); }
    const program = createDoctorProgram({ optionDefaults: { config: "" } });
    const chat = program.commands.find(command => command.name() === "chat")!;
    chat.action(() => undefined);
    await program.parseAsync(["chat", "-c", "/explicit/config"], { from: "user" });
    expect(commandOptionsWithSources(chat).config).toBe("/explicit/config");
    expect(chat.helpInformation()).toContain("--profile");
  });
});
