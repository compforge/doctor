import { afterEach, expect, test } from "bun:test";
import { Command } from "commander";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCommandDefaults } from "../src/app/command-defaults";
import { commandOptionsWithSources, withoutShadowedDefaults } from "../src/app/option-sources";
import { prepareCommand } from "../src/app/prepare";
import { bootstrap, createLocalAgentContext, effectiveAgentProfile } from "../src/app/bootstrap";
import { domainInput } from "../src/command/options";
import { overviewSampleCount } from "../src/overview/options";
import { resolveCollectNamespace } from "../src/infra/k8s/context";
import { profileToUpload, validateProfile } from "../src/app/config/config";
import type { Profile } from "../src/command/profile";
import { runCommand } from "../src/app/command";
import { CommandStatus } from "../src/command";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "doctor-precedence-"));
  directories.push(directory);
  return directory;
}

function parsedOptions(args: string[] = []) {
  const program = new Command().option("--kubeconfig <path>");
  const command = program.command("overview")
    .option("--sample-count <number>", "", Number)
    .option("--namespace <name>")
    .option("--collect");
  applyCommandDefaults(program, { overview: { sampleCount: 5, namespace: "distribution", collect: false } });
  program.parse(["overview", ...args], { from: "user" });
  return commandOptionsWithSources<{ sampleCount?: number; namespace?: string; collect?: boolean }>(command);
}

test("profile beats Distribution defaults across the domain-input adapter", () => {
  const profile: Profile = { readonly: true, namespace: "profile-ns", overview: { sample_count: 9 } };
  const options = withoutShadowedDefaults(domainInput(parsedOptions()), profile);
  expect(overviewSampleCount(options.sampleCount, profile.overview?.sample_count)).toBe(9);
  expect(resolveCollectNamespace(options, { name: "test", configPath: "unused", value: profile, pluginConfig: {} }))
    .toEqual({ namespace: "profile-ns", source: "profile:test" });
  expect(options.collect).toBe(false);
});

test("explicit values win even when equal to the Distribution default", () => {
  const options = withoutShadowedDefaults(parsedOptions(["--sample-count", "5", "--namespace", "cli"]),
    { readonly: true, namespace: "profile", overview: { sample_count: 9 } });
  expect(options.sampleCount).toBe(5);
  expect(options.namespace).toBe("cli");
});

test("defaults remain available without profile configuration; explicit zero is not absent", () => {
  expect(withoutShadowedDefaults(parsedOptions(), { readonly: true }).sampleCount).toBe(5);
  const options = withoutShadowedDefaults(parsedOptions(["--sample-count", "0"]),
    { readonly: true, overview: { sample_count: 9 } });
  expect(options.sampleCount).toBe(0);
  expect(() => overviewSampleCount(options.sampleCount, 9)).toThrow("正整数");
});

test("the shared lifecycle removes shadowed defaults before executing a spec", async () => {
  const directory = temporaryDirectory();
  const config = join(directory, "config.yaml");
  writeFileSync(config, "default_profile: test\nprofiles:\n  test:\n    readonly: true\n    overview:\n      sample_count: 9\n");
  const options = { ...parsedOptions(), config, format: "json" };
  let selected: number | undefined;
  const previousExitCode = process.exitCode;
  try {
    await runCommand({ name: "test", async run(context, input) {
      selected = overviewSampleCount(input.sampleCount, context.profile.value.overview?.sample_count);
      return { status: CommandStatus.Ok, artifacts: [], output: undefined };
    } }, options, domainInput(options), { printProfile: false });
    expect(selected).toBe(9);
    expect(process.exitCode).toBe(0);
  } finally { process.exitCode = previousExitCode; }
});

test("debug --image defaults yield to the profile without affecting image command arguments", () => {
  for (const name of ["debug", "image"]) {
    const program = new Command();
    const command = program.command(name).option("--image <image>", "", "distribution-image");
    program.parse([name], { from: "user" });
    const options = withoutShadowedDefaults(commandOptionsWithSources(command),
      { readonly: true, kube: { debug_image: "profile-image" } });
    expect(options.image).toBe(name === "debug" ? undefined : "distribution-image");
  }
});

test("empty explicit targets error instead of falling back to the profile", () => {
  expect(() => withoutShadowedDefaults(parsedOptions(["--namespace", ""]),
    { readonly: true, namespace: "profile" })).toThrow("--namespace 不能为空");
});

test("Chat uses the invocation kubeconfig for validation, Skill injection, and remote upload", () => {
  const directory = temporaryDirectory();
  const config = join(directory, "config.yaml");
  const kubeconfig = join(directory, "selected-kubeconfig");
  writeFileSync(kubeconfig, "selected config bytes");
  writeFileSync(config, "default_profile: test\nprofiles:\n  test:\n    readonly: true\n    kube:\n      kubeconfig_path: /missing/profile-target\n");
  const context = prepareCommand({ config, kubeconfig, context: "selected" }, false);
  const effective = effectiveAgentProfile(context.profile.value, context.options.environment);
  expect(validateProfile(effective).errors).toEqual([]);
  expect(createLocalAgentContext("test", effective, context.options.environment?.context).shellEnv)
    .toMatchObject({ TARGET_KUBECONFIG: kubeconfig, TARGET_KUBE_CONTEXT: "selected" });
  expect(profileToUpload(effective).kube?.kubeconfig).toBe("selected config bytes");
  expect(context.profile.value.kube?.kubeconfig_path).toBe("/missing/profile-target");
  expect(validateProfile(effectiveAgentProfile(effective, { kubeconfig: "/missing/explicit" })).errors)
    .toContain("kubeconfig path not found: /missing/explicit");
});

test("remote Chat refuses to silently ignore an unsupported explicit context", async () => {
  const directory = temporaryDirectory();
  const config = join(directory, "config.yaml");
  writeFileSync(config, "default_profile: test\nprofiles:\n  test:\n    readonly: true\n");
  const context = prepareCommand({ config, context: "explicit" }, false);
  await expect(bootstrap({ config, server: true }, undefined, context))
    .rejects.toThrow("远端 chat 暂不支持 --context");
});
