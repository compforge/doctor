import { inspectExtension, traceExtension } from "../../packages/plugin/tests/extension-fixture";
import { afterEach, describe, expect, test } from "bun:test";
import { createServiceCatalog, type PluginDefinition } from "@compforge/doctor-plugin";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
    name: "api",
    workloads: [],
    logs: { default: true },
    extensions: [traceExtension({
      access: {},
      endpoint: { host: "private-target", port: 80 },
      resolve: async () => { throw new Error("Discovery must not access the target"); },
    }),
    inspectExtension({
      access: {}, accepts: ["message_id"], provides: ["message"],
      resolveTarget: async () => { throw new Error("Discovery must not resolve access credentials"); },
      inspect: async () => { throw new Error("Discovery must not inspect the target"); },
    })]
  }]),
};

describe("Plugin discovery", () => {
  test("no active Plugin produces an empty list", async () => {
    expect(await listPlugins(undefined, temporaryRoot())).toEqual([]);
  });

  test("injected Plugin wins over Host state and only safe declarations are exposed", async () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "active.json"), "invalid host state");
    const result = await listPlugins(injected, root);
    expect(result).toEqual([{
      id: "discovery-test", version: "1.0.0", source: "injected",
      services: [{
        name: "api", aliases: [], detectors: [], environmentProbes: [], extensions: [{ id: "trace.resolve", kind: "trace.resolve" }, { id: "inspect", kind: "facts.inspect" }],
        details: {
          workloads: [], dependencies: [], dataSources: [],
          inspect: { accepts: ["message_id"], provides: ["message"], expands: [], limitations: [] },
          access: [
            { owner: "extensions.trace.resolve", requirements: { kubernetes: [] } },
            { owner: "extensions.inspect", requirements: { kubernetes: [] } },
          ],
        },
      }],
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
      id: "example", version: "0.0.10", source: "installed",
      services: [
        { name: "example-api", detectors: [], environmentProbes: [] },
        { name: "example-worker", detectors: [], environmentProbes: [] },
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
    const root = temporaryRoot();
    writeFileSync(join(root, "config.yaml"), "profiles: [invalid");
    writeFileSync(join(root, "kubectl"), '#!/bin/sh\ntouch "$DOCTOR_HOME/kubectl-called"\nexit 99\n', { mode: 0o755 });
    const result = Bun.spawnSync({
      cmd: [process.execPath, "run", resolve(import.meta.dir, "fixtures/plugin-cli.ts"), ...args],
      cwd: root, stdout: "pipe", stderr: "pipe",
      env: { ...process.env, DOCTOR_HOME: root, DOCTOR_CONFIG: join(root, "config.yaml"), PATH: `${root}:${process.env.PATH}` },
    });
    expect(existsSync(join(root, "kubectl-called"))).toBe(false);
    return result;
  }

  test("bare plugin displays the injected Plugin and Services", () => {
    const result = run("plugin");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("test@0.0.1 (injected)");
    expect(result.stdout.toString()).toContain("test-store");
    expect(result.stdout.toString()).toContain("aliases: store");
  });

  test("JSON is directly consumable without profile or target preparation", () => {
    const result = run("plugin", "--format", "json");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({
      plugins: [{
        id: "test", version: "0.0.1", source: "injected",
        services: [{
          name: "test-store", aliases: ["store"], detectors: [], environmentProbes: [],
          details: { workloads: [], dependencies: [], dataSources: [{ id: "cache", kind: "redis", backend: "redis" }], access: [] },
        }],
      }]
    });
    expect(result.stderr.toString()).toBe("");
  });

  test("invalid format is rejected", () => {
    const result = run("plugin", "--format", "xml");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("Allowed choices are text, json");
  });

  test("service filter renders offline details for legacy Services", () => {
    const result = run("plugin", "--service", "test-store");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("Service: test-store");
    expect(result.stdout.toString()).toContain("cache (redis/redis)");
    expect(result.stdout.toString()).toContain("尚未检查目标环境");
  });

  test("service filter keeps JSON directly consumable", () => {
    const result = run("plugin", "--service", "store", "-f", "json");
    expect(result.exitCode).toBe(0);
    const services = JSON.parse(result.stdout.toString()).plugins[0].services;
    expect(services).toHaveLength(1);
    expect(services[0].name).toBe("test-store");
    expect(services[0].aliases).toEqual(["store"]);
    expect(services[0].details.dataSources).toEqual([{ id: "cache", kind: "redis", backend: "redis" }]);
  });

  test("unknown Service fails without returning a misleading empty catalog", () => {
    const result = run("plugin", "--service", "missing", "-f", "json");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("Unknown Service 'missing'");
    expect(result.stdout.toString()).not.toContain('"plugins"');
  });

  test("install and uninstall remain subcommands", () => {
    for (const name of ["install", "uninstall"]) {
      const result = run("plugin", name, "--help");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain(`Usage: doctor plugin ${name}`);
    }
  });
});
