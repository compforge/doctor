import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServiceCatalog, describeService, secretDataSource, connectionDataSources, DOCTOR_PLUGIN_API_VERSION, type ServiceDefinition } from "@compforge/doctor-plugin";
import { examplePlugin } from "../../plugins/example/src";
import { CommandContext } from "../src/command";
import { runCollectInspect, type InspectDiagnosis } from "../src/collect/inspect";
import { projectInspectServiceEvidence } from "../src/collect/inspect/detector";
import { buildInspectSummary, buildInspectHtmlSections } from "../src/collect/inspect/render";
import { validatePluginDefinition } from "../src/plugin/definition";
import type { ExecResult, Executor } from "@compforge/harness-toolbox/kubernetes/executor";

const response = (stdout = ""): ExecResult => ({ ok: true, stdout, stderr: "", exitCode: 0, timedOut: false, durationMs: 1, command: ["kubectl"] });
const access = { kubernetes: [{ requirement: "required" as const, rule: { verb: "get", resource: "secrets" }, purpose: "read selected configuration" }] };
const service: ServiceDefinition = { name: "api", component: { name: "api", repository: { forge: { name: "test" }, path: "api" } }, workloads: [] };
const manifest = { manifestVersion: 1 as const, pluginApiVersion: DOCTOR_PLUGIN_API_VERSION, id: "test", version: "0.0.1",
  requiresDoctor: ">=0.1.244", contentDigest: `sha256:${"0".repeat(64)}`, main: "./plugin.mjs", skills: [] };

test("Secret declarations stay offline and validate their selected keys and identity", () => {
  const resolve = async () => { throw new Error("must remain offline"); };
  for (const keys of [[], [""], ["a", "a"], ["a/b"]]) expect(() => secretDataSource("rules", { keys, access, resolve })).toThrow();
  const source = secretDataSource("rules", { keys: ["TRUSTED_NETWORKS"], access, resolve });
  const definition = (dataSources: unknown) => ({ id: "test", version: "0.0.1", services: { services: [{ ...service, dataSources }] } });
  expect(validatePluginDefinition(definition([source]), manifest).services.find("api")?.dataSources).toEqual([source]);
  expect(() => validatePluginDefinition(definition([source, source]), manifest)).toThrow();
  expect(() => validatePluginDefinition(definition([{ ...source, keys: [] }]), manifest)).toThrow("keys");
  expect(() => validatePluginDefinition(definition([{ ...source, createClient: undefined }]), manifest)).toThrow("createClient");
  expect(connectionDataSources({ dataSources: [source] })).toEqual([]);
  expect(describeService({ ...service, dataSources: [source] }).details.dataSources).toEqual([
    { kind: "secret", id: "rules", keys: ["TRUSTED_NETWORKS"], description: undefined },
  ]);
});

// @spec Only selected keys enter the bundle; absent keys, denied reads and malformed values retain different meanings.
for (const scenario of ["default", "config", "env", "image", "denied", "undeclared", "missing-secret", "invalid", "invalid-utf8", "resolution-failed"] as const) {
  test(`Inspect collects declared Secret sources through scoped access: ${scenario}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "inspect-secret-"));
    const config = join(directory, "profile.yaml"); writeFileSync(config, "");
    let resolutions = 0, reads = 0;
    const source = secretDataSource("rules", { keys: ["TRUSTED_NETWORKS", "EMPTY", "ABSENT"], access: scenario === "undeclared" ? {} : access,
      resolve: async () => {
        resolutions++;
        if (scenario === "resolution-failed") throw new Error("reference unavailable");
        return { namespace: "demo", name: "custom-secret" };
      } });
    const plugin = { ...examplePlugin, services: createServiceCatalog([{ ...service, dataSources: [source] }]) };
    const executor: Executor = {
      run: async args => {
        if (args[0] === "config") return response("test\nhttps://cluster.test");
        if (args[0] === "auth") return response("yes");
        if (args[1] === "secrets") {
          reads++;
          expect(args).toContain("custom-secret");
          if (scenario === "denied") return { ...response(), ok: false, exitCode: 1, stderr: 'secrets "custom-secret" is forbidden' };
          if (scenario === "missing-secret") return { ...response(), ok: false, exitCode: 1, stderr: 'secrets "custom-secret" not found' };
          return response(JSON.stringify({ metadata: { resourceVersion: "42" }, data: {
            TRUSTED_NETWORKS: scenario === "invalid" ? "%%%not-base64%%%" : scenario === "invalid-utf8" ? "/w==" : Buffer.from("10.0.0.1/32:8060").toString("base64"),
            EMPTY: "", TOKEN: Buffer.from("private-token-never-collect").toString("base64"),
          } }));
        }
        return response('{"items":[]}');
      },
      exec: async () => { throw new Error("Secret source must not exec"); },
    };
    const context = new CommandContext({}, undefined, { plugin });
    try {
      await runCollectInspect({ namespace: "demo", services: ["api"],
        field: scenario === "default" ? undefined : scenario === "env" || scenario === "image" ? scenario : "config",
        config, format: "summary" }, plugin, context, executor);
      const artifact = context.artifacts.list()[0]!;
      const diagnosis: InspectDiagnosis = JSON.parse(readFileSync(join(artifact.path, "diagnosis.json"), "utf8"));
      const observations = diagnosis.evidence.observations.filter(item => item.kind === "secret-configuration");
      if (scenario === "env" || scenario === "image") {
        expect(observations).toEqual([]); expect(reads).toBe(0); expect(resolutions).toBe(0); return;
      }
      expect(observations).toHaveLength(1);
      const observation = observations[0]!;
      const success = scenario === "default" || scenario === "config";
      expect(observation.status).toBe(success ? "collected" : "unavailable");
      const gaps = diagnosis.findings.filter(item => item.kind === "evidence.insufficient" && item.subject === "secret-configuration");
      expect(gaps.length > 0).toBe(!success);
      if (success) {
        expect(observation).toMatchObject({ namespace: "demo", name: "custom-secret", resourceVersion: "42",
          values: { TRUSTED_NETWORKS: "10.0.0.1/32:8060", EMPTY: "" }, missingKeys: ["ABSENT"] });
        expect(observation.observedAt).toBeTruthy();
        expect(projectInspectServiceEvidence(diagnosis.evidence, "test", ["api"]).observations)
          .toContainEqual(expect.objectContaining({ kind: "secret-configuration", value: expect.objectContaining({ missingKeys: ["ABSENT"] }) }));
        expect(buildInspectSummary(diagnosis)).toContain("custom-secret");
        expect(buildInspectHtmlSections(diagnosis).map(section => section.html).join("\n")).toContain("10.0.0.1/32:8060");
        if (scenario === "config") expect(diagnosis.evidence.search?.matches).toContainEqual(expect.objectContaining({
          name: "TRUSTED_NETWORKS", source: "secret", secret: "custom-secret", namespace: "demo", resourceVersion: "42",
        }));
      } else {
        expect(observation.values).toEqual({}); expect(observation.missingKeys).toEqual([]);
      }
      if (scenario === "undeclared" || scenario === "resolution-failed") expect(reads).toBe(0);
      if (scenario === "denied") { expect(reads).toBe(1); expect(observation.reason).toContain("forbidden"); }
      // Check serialized raw steps as well as the detector projection, not just terminal text.
      for (const path of readdirSync(artifact.path, { recursive: true }).map(String)) {
        if (!/\.(json|md|html|txt)$/.test(path)) continue;
        const text = readFileSync(join(artifact.path, path), "utf8");
        expect(text).not.toContain("private-token-never-collect");
        expect(text).not.toContain(Buffer.from("private-token-never-collect").toString("base64"));
        expect(text).not.toContain("%%%not-base64%%%");
      }
    } finally {
      await context.disposeClients();
      for (const artifact of context.artifacts.list()) rmSync(dirname(artifact.path), { recursive: true, force: true });
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

// @spec Toolbox reads still cross Doctor access guards and retain cancellation through Inspect's resource snapshots.
test("Secret client outlives its borrower and disposal cancels the captured Kubernetes request", async () => {
  const { ClientManager } = await import("@compforge/harness-common");
  const { createPluginContext } = await import("../src/plugin/context");
  const { executorResourceReader, snapshotResourceReader } = await import("../src/infra/k8s/resources");
  let started!: () => void;
  const reading = new Promise<void>(resolve => { started = resolve; });
  let finished = false;
  const executor: Executor = {
    run: async (args, options) => {
      expect(args.slice(0, 3)).toEqual(["get", "secrets", "custom-secret"]);
      expect(options?.timeoutMs).toBe(1000);
      started();
      try { return await new Promise<never>((_resolve, reject) => options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true })); }
      finally { finished = true; }
    },
    exec: async () => { throw new Error("unexpected exec"); },
  };
  const clients = new ClientManager();
  const context = createPluginContext(executor, { namespace: "demo" }, {
    clients, service, capability: { access },
    environment: { name: "test", kind: "kubernetes", context: "test", server: "https://cluster.test" },
    resources: snapshotResourceReader(executorResourceReader(executor, "demo")),
  });
  try {
    const client = await context.clients.get(secretDataSource("cancel", {
      keys: ["RULE"], access, resolve: async () => ({ namespace: "demo", name: "custom-secret" }),
    }));
    await context.dispose();
    const pending = client.read({ timeoutMs: 1000 });
    const outcome = pending.then(() => undefined, error => error);
    await reading;
    await client.dispose();
    expect(String(await outcome)).toContain("disposed");
    expect(finished).toBe(true);
  } finally { await context.dispose(); await clients.dispose(); }
});
