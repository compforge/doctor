import { expect, spyOn, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createServiceCatalog } from "@compforge/doctor-plugin";
import type { Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import { CommandContext, CommandInputError, CommandStatus } from "../src/command";
import { resolveDataSourceTarget } from "../src/datasource/workload";
import * as databaseAccess from "../src/datasource/database";
import { dbCommand } from "../src/collect/db/command";

function fixture(names = ["api-1", "api-2"], containers = ["server"]) {
  const calls: string[][] = [];
  const service = {
    name: "api", component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/api" } },
    workloads: [{ name: "main", platform: "kubernetes" as const, location: { kind: "labels" as const, labels: { app: "api" } } }],
    dataSources: [{ id: "database", kind: "db" as const, backend: "mysql" as const, source: { clientKey: "database", createClient: () => { throw new Error("Unexpected database access"); } } }],
  };
  const command = new CommandContext({}, undefined, { format: "summary", plugin: {
    id: "test", version: "0.0.1", services: createServiceCatalog([service]),
  } });
  const executor: Executor = {
    run: async args => {
      calls.push(args);
      const stdout = args[0] === "config" ? "test\nhttps://cluster.test" : JSON.stringify({ items: names.map(name => ({
        metadata: { name, uid: name + "-uid", namespace: "demo" },
        spec: { containers: containers.map(name => ({ name })) }, status: { phase: "Running" },
      })) });
      if (args[0] !== "config" && args.join(" ") !== "get pods -l app=api -o json") throw new Error("Selection must not read credentials");
      return { ok: true, stdout, stderr: "", exitCode: 0, timedOut: false, durationMs: 1, command: args };
    },
    exec: async () => { throw new Error("Selection must not exec"); },
  };
  return { command, calls, input: { service, executor, namespace: "demo", interactive: false, commandContext: command, selection: { purpose: "configuration" } } };
}

for (const scenario of [
  { name: "replicas", pods: ["api-1", "api-2"], containers: ["server"], selection: {}, expected: ["--pod", "api-1", "api-2"] },
  { name: "missing Pod", pods: ["api-1"], containers: ["server"], selection: { pod: "missing" }, expected: ["没有匹配", "missing"] },
  { name: "containers", pods: ["api-1"], containers: ["server", "worker"], selection: {}, expected: ["--container", "server", "worker"] },
  { name: "invalid container", pods: ["api-1"], containers: ["server"], selection: { container: "missing" }, expected: ["未声明 Container", "missing", "server"] },
]) test(`datasource ${scenario.name} selection is an actionable input error`, async () => {
  const f = fixture(scenario.pods, scenario.containers);
  try {
    const error = await resolveDataSourceTarget({ ...f.input, ...scenario.selection }).catch(error => error);
    expect(error).toBeInstanceOf(CommandInputError);
    for (const text of scenario.expected) expect(error.message).toContain(text);
  } finally { await f.command.disposeClients(); }
});

test("explicit Pod and container selections resolve the requested source without fallback", async () => {
  const f = fixture(undefined, ["server", "worker"]);
  try {
    expect(await resolveDataSourceTarget({ ...f.input, pod: "api-2", container: "worker" }))
      .toEqual({ pod: "api-2", container: "worker" });
  } finally { await f.command.disposeClients(); }
});

test("a unique Pod and container need no selection flags", async () => {
  const f = fixture(["api-1"]);
  try { expect(await resolveDataSourceTarget(f.input)).toEqual({ pod: "api-1", container: "server" }); }
  finally { await f.command.disposeClients(); }
});

test("unknown configuration failures remain redacted rather than being promoted to input errors", async () => {
  const f = fixture();
  const environment = spyOn(f.command, "ensureEnvironment").mockResolvedValue();
  const resolve = spyOn(databaseAccess, "resolveDatabaseConfig").mockRejectedValue(new Error("password=fixture-secret"));
  try {
    const result = await dbCommand.run(f.command, { services: ["api"], database: "app", execute: "SELECT 1", interactive: false });
    expect(result.status).toBe(CommandStatus.Failed);
    const directory = result.artifacts[0]!.path;
    for (const file of ["summary.md", "diagnosis.json", "collection.json"]) {
      const text = readFileSync(join(directory, file), "utf8");
      expect(text).not.toContain("fixture-secret");
      expect(text).toContain("数据库操作失败或超时");
    }
  } finally {
    resolve.mockRestore(); environment.mockRestore(); await f.command.disposeClients();
    for (const artifact of f.command.artifacts.list()) rmSync(artifact.path, { recursive: true, force: true });
  }
});
