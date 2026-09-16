import { afterEach, describe, expect, test } from "bun:test";
import { createServiceCatalog, type PluginDefinition } from "@compforge/doctor-plugin";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildPluginArchive } from "../../packages/plugin/scripts/pack";
import { installPlugin, listPlugins } from "../src/plugin";

const roots: string[] = [];
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "doctor-plugin-discovery-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const injected: PluginDefinition = {
  id: "discovery-test", version: "1.0.0",
  validateConfig: () => { throw new Error("Discovery must not validate runtime configuration"); },
  services: createServiceCatalog([{
    name: "api", workloads: [],
    capabilities: {
      log: { default: true },
      traceId: {
        access: {},
        endpoint: { host: "private-target", port: 80 },
        resolve: async () => { throw new Error("Discovery must not access the target"); },
      },
      metric: undefined,
    },
    contributions: {
      inspect: {
        access: {}, accepts: ["message_id"], provides: ["message"],
        resolveTarget: async () => { throw new Error("Discovery must not resolve access credentials"); },
        inspect: async () => { throw new Error("Discovery must not inspect the target"); },
      },
    },
  }]),
};

describe("Plugin discovery", () => {
  test("no active Plugin produces an empty list", async () => {
    expect(await listPlugins(undefined, temporaryRoot())).toEqual([]);
  });

  test("injected Plugin wins over Host state and only declaration names are exposed", async () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "active.json"), "invalid host state");
    const result = await listPlugins(injected, root);
    expect(result).toEqual([{
      id: "discovery-test", version: "1.0.0", source: "injected",
      services: [{ name: "api", capabilities: ["log", "traceId"], contributions: ["inspect"] }],
    }]);
    expect(JSON.stringify(result)).not.toContain("private-target");
  });

  test("Host active Plugin uses the existing verified loader", async () => {
    const root = temporaryRoot();
    const archive = await buildPluginArchive(resolve(import.meta.dir, "../../plugins/example"), join(root, "dist"));
    const installRoot = join(root, "plugins");
    await installPlugin(archive, installRoot);
    const result = await listPlugins(undefined, installRoot);
    expect(result).toMatchObject([{
      id: "example", version: "0.0.6", source: "installed",
      services: [
        { name: "example-api", capabilities: ["config", "log"], contributions: [] },
        { name: "example-worker", capabilities: ["log", "stores"], contributions: [] },
      ],
    }]);
  });

  test("broken active state is an error rather than an empty catalog", async () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "active.json"), JSON.stringify({ schemaVersion: 1, ref: "missing@1.0.0" }));
    await expect(listPlugins(undefined, root)).rejects.toThrow();
  });
});

describe("doctor plugin CLI", () => {
  function run(...args: string[]) {
    return Bun.spawnSync({
      cmd: [process.execPath, "run", resolve(import.meta.dir, "fixtures/plugin-cli.ts"), ...args],
      cwd: temporaryRoot(), stdout: "pipe", stderr: "pipe",
    });
  }

  test("bare plugin displays the injected Plugin and Services", () => {
    const result = run("plugin");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("test@0.0.1 (injected)");
    expect(result.stdout.toString()).toContain("test-store");
  });

  test("JSON is directly consumable without profile or target preparation", () => {
    const result = run("plugin", "--format", "json");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({ plugins: [{
      id: "test", version: "0.0.1", source: "injected",
      services: [{ name: "test-store", capabilities: ["stores"], contributions: [] }],
    }] });
    expect(result.stderr.toString()).toBe("");
  });

  test("invalid format is rejected", () => {
    const result = run("plugin", "--format", "xml");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("Allowed choices are text, json");
  });

  test("install and uninstall remain subcommands", () => {
    for (const name of ["install", "uninstall"]) {
      const result = run("plugin", name, "--help");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain(`Usage: doctor plugin ${name}`);
    }
  });
});
