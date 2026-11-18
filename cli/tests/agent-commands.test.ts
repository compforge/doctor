import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServiceCatalog, type PluginDefinition } from "@compforge/doctor-plugin";
import { prepareAgentCommands } from "../src/app/agent-commands";
import { resolveWorkingProfile } from "../src/app/profile";

const plugin = { id: "sample", version: "1.0.0", services: createServiceCatalog([]) } satisfies PluginDefinition;

test("local Agent command reuses Doctor, preserves arguments, and cleans its session entry", () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-agent-command-test-"));
  const config = join(root, "config.yaml");
  writeFileSync(config, [
    "default_profile: other",
    "profiles:",
    "  other:",
    "    readonly: true",
    "  chosen:",
    "    readonly: true",
    "    namespace: vke-system",
    "",
  ].join("\n"));
  const prepared = prepareAgentCommands({ samplectl: {
    name: "samplectl", version: "4.5.6", plugin: "sample@1.0.0", commands: "plugin",
    optionDefaults: { config: "" },
  } }, plugin, {
    profileName: "chosen", configPath: config,
    kubeconfig: "/path with space/config", namespace: "vke-system",
  }, [process.execPath, "run", resolve(import.meta.dir, "fixtures/distribution-cli.ts")]);
  try {
    const command = join(prepared.shellEnv.PATH!.split(":")[0]!, "samplectl");
    expect(existsSync(command)).toBe(true);
    const result = Bun.spawnSync({
      cmd: [command, "version"],
      env: { ...process.env, ...prepared.shellEnv },
      stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toStartWith("samplectl 4.5.6\n");
    expect(result.stdout.toString()).toContain("plugin sample@1.0.0\n");
    const previous = process.env.DOCTOR_PROFILE;
    process.env.DOCTOR_PROFILE = prepared.shellEnv.DOCTOR_PROFILE;
    try {
      expect(resolveWorkingProfile({ config }).name).toBe("chosen");
      expect(resolveWorkingProfile({ config, profile: "other" }).name).toBe("other");
    } finally {
      if (previous === undefined) delete process.env.DOCTOR_PROFILE;
      else process.env.DOCTOR_PROFILE = previous;
    }
  } finally {
    const command = join(prepared.shellEnv.PATH!.split(":")[0]!, "samplectl");
    prepared.dispose();
    expect(existsSync(dirname(command))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Agent command passes shell-sensitive arguments through unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-argv-test-"));
  const entry = join(root, "args.mjs");
  writeFileSync(entry, "process.stdout.write(JSON.stringify(process.argv.slice(2)))\n");
  const prepared = prepareAgentCommands({ samplectl: { name: "samplectl", plugin: "sample@1.0.0" } }, plugin, {
    profileName: "chosen", configPath: "/path with 'quote'/config.yaml",
  }, [process.execPath, entry]);
  try {
    const result = Bun.spawnSync({
      cmd: [join(prepared.shellEnv.PATH!.split(":")[0]!, "samplectl"), "a b", "single'quote", "$HOME"],
      stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual([
      "--distribution", expect.any(String), "--config", "/path with 'quote'/config.yaml",
      "a b", "single'quote", "$HOME",
    ]);
  } finally {
    prepared.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Agent command rejects a different Plugin before creating an executable entry", () => {
  expect(() => prepareAgentCommands({ samplectl: {
    name: "samplectl", plugin: "other@1.0.0",
  } }, plugin, { profileName: "chosen", configPath: "/missing/config" }))
    .toThrow("requires the current Plugin");
});
