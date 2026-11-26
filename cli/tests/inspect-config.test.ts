import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServiceCatalog, fileDataSource, describeService, type ServiceDefinition } from "@compforge/doctor-plugin";
import { createCollectCommand } from "../src/collect/composite";
import { finalizeResult } from "./report-fixture";
import { readBundleIndex, readBundleText } from "./bundle-fixture";
import { examplePlugin } from "../../plugins/example/src";
import { CommandContext } from "../src/command";
import { runCollectInspect, type InspectDiagnosis } from "../src/collect/inspect";
import { parseContainerEnvironment } from "../src/collect/inspect/probe/container-environment";
import { inspectFileSources } from "../src/collect/inspect/fact/inspect";
import { parseFileConfiguration } from "../src/collect/inspect/probe/file-configuration";
import type { ExecResult, Executor } from "@compforge/harness-toolbox/kubernetes/executor";

const yaml = "sandbox:\n  provider:\n    config:\n      endpoint: http://sandbox.example:8080\nlist: [one, two]\n";
const response = (stdout = ""): ExecResult => ({ ok: true, stdout, stderr: "", exitCode: 0, timedOut: false, durationMs: 1, command: ["kubectl"] });

test("configuration parsing preserves nested paths and literals without echoing invalid secret lines", () => {
  expect(parseFileConfiguration(new TextEncoder().encode(yaml), "/config.yaml")).toEqual({
    "sandbox.provider.config.endpoint": "http://sandbox.example:8080", "list[0]": "one", "list[1]": "two",
  });
  expect(parseFileConfiguration(new TextEncoder().encode('{"enabled":false,"empty":"","count":0}'), "/config.json"))
    .toEqual({ enabled: false, empty: "", count: 0 });
  for (const raw of ["password: [private-value", "a: &a {b: *a}"]) {
    try { parseFileConfiguration(new TextEncoder().encode(raw), "/config.yaml"); throw new Error("expected parsing failure"); }
    catch (error) { expect(String(error)).not.toContain(raw); expect(String(error)).toContain("/config.yaml"); }
  }
  expect(() => parseFileConfiguration(new Uint8Array([255]), "/config.yaml")).toThrow("UTF-8");
  expect(() => parseFileConfiguration(new TextEncoder().encode('a.b: 1\na: {b: 2}'), "/config.yaml")).toThrow("冲突");
});

test("Pod env preserves ordinary literals and masks credentials in embedded env lists", () => {
  const raw = 'LIST=[1,{"name":"API_TOKEN","value":"private-fixture-value"}]\0BIND=[::1]:8090\0JSON={ "enabled": true }\0';
  expect(parseContainerEnvironment(raw)).toEqual({
    LIST: '[1,{"name":"API_TOKEN","value":"[redacted]"}]', BIND: "[::1]:8090", JSON: '{ "enabled": true }',
  });
});

for (const scenario of ["default-collect", "ok", "empty", "missing", "invalid", "oversized", "denied", "env-only", "group-ok", "mixed-missing", "mixed-invalid", "mixed-oversized"] as const) {
  test(`Inspect config collects file sources and Pod env, retaining provenance and gaps: ${scenario}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "inspect-config-test-"));
    const config = join(directory, "profile.yaml"); writeFileSync(config, "");
    let resolutions = 0;
    let fileReads = 0;
    const grouped = scenario === "default-collect" || scenario.startsWith("mixed-") || scenario === "group-ok";
    const paths = grouped ? ["/etc/config.yaml", "/etc/secret.yaml"] : ["/etc/config.yaml"];
    const file = fileDataSource(paths, {
      workload: "api", description: "mounted configuration", access: { kubernetes: [{
        requirement: "required", rule: { verb: "create", resource: "pods/exec" }, purpose: "read config",
      }] },
      resolve: async () => { resolutions++; return { namespace: "demo", pod: "api-0", container: "main" }; },
    });
    const service: ServiceDefinition = {
      name: "api", component: { name: "api", repository: { forge: { name: "test" }, path: "api" } },
      workloads: [{ name: "api", platform: "kubernetes", container: "main", location: { kind: "labels", labels: { app: "api" } } }],
      dataSources: [file],
    };
    if (scenario === "default-collect") expect(inspectFileSources({ ...service, workloads: [] })).toEqual([]);
    const plugin = { ...examplePlugin, services: createServiceCatalog([service]) };
    expect(resolutions).toBe(0);
    expect(file).not.toHaveProperty("id"); expect(file).not.toHaveProperty("kind");
    expect(describeService(service).details.dataSources).toContainEqual({ kind: "file", paths, workload: "api", description: "mounted configuration" });
    const executor: Executor = {
      run: async args => {
        if (args[0] === "config") return response("test\nhttps://cluster.test");
        if (args[0] === "auth") return response(scenario === "denied" && args.includes("pods/exec") ? "no" : "yes");
        if (args[1] === "pods") return response(JSON.stringify({ items: [{
          metadata: { name: "api-0", namespace: "demo", uid: "pod-uid", labels: { app: "api" } },
          spec: { containers: [{ name: "main", image: "api:v1" }] }, status: { phase: "Running" },
        }] }));
        return response('{"items":[]}');
      },
      exec: async (target, args, options) => {
        expect(target).toMatchObject({ pod: "api-0", container: "main" });
        if (scenario === "denied") return { ...response(), ok: false, exitCode: 1, stderr: "pods/exec is forbidden" };
        if (args[0] === "date") return response(`${Date.now() / 1000}\n+0000\nUTC`);
        if (args[0] === "printenv") return response("SANDBOX_MODE=pod\0OTHER=keep-in-evidence\0AWS_SECRET_ACCESS_KEY=private-fixture-value\0");
        fileReads++;
        expect(args.slice(0, 2)).toEqual(["sh", "-c"]);
        expect(args.slice(3)).toEqual(["file-source", "1048577", ...paths]);
        if (scenario === "missing") return { ...response(), ok: false, exitCode: 1, stderr: "private-error-line" };
        const raw = scenario === "invalid" ? "password: [private-value" : scenario === "empty" ? "{}" : scenario === "oversized" ? "x".repeat(1048577) : yaml;
        options?.onStdoutBytes?.(Buffer.from(`0 ${Buffer.concat([Buffer.from(raw), Buffer.from([0]), Buffer.from("000")]).toString("base64")}\n`));
        if (grouped) {
          const body = scenario === "mixed-invalid" ? "password: [private-value" : scenario === "mixed-oversized" ? "x".repeat(1048577) : scenario === "default-collect"
            ? "runtime:\n  sandbox:\n    sidecars:\n    - name: helper\n      env:\n        SNAPSHOT_S3_ENDPOINT: https://storage.example\n        AWS_SECRET_ACCESS_KEY: private-fixture-value" : "extra: true";
          const status = scenario === "mixed-missing" ? "001" : "000";
          options?.onStdoutBytes?.(Buffer.from(`1 ${Buffer.concat([Buffer.from(body), Buffer.from([0]), Buffer.from(status)]).toString("base64")}\n`));
        }
        return response();
      },
    };
    const context = new CommandContext({}, undefined, { plugin });
    try {
      if (scenario === "default-collect") {
        const command = createCollectCommand(async () => {
          const child = await context.artifacts.capture(() => runCollectInspect({
            namespace: "demo", services: ["api"], deploymentConfig: false, dependencies: false, config,
          }, plugin, context, executor));
          return { ...child.value, artifacts: child.artifacts };
        });
        const input = { bizIds: [], kinds: ["inspect" as const] };
        const result = await command.run(context, input);
        const output = join(directory, "bundle");
        await finalizeResult(context, command, result, { output, format: "bundle" }, input);
        const archive = output + ".tar.gz";
        const child = readBundleIndex(archive, "bundle").children![0]!;
        const evidence = readBundleText(archive, join("bundle", dirname(child.manifest), "raw/observations.json"));
        expect(evidence).not.toContain("private-fixture-value");
        const observations = JSON.parse(evidence) as InspectDiagnosis["evidence"]["observations"];
        expect(observations).toContainEqual(expect.objectContaining({
          kind: "container-environment", pod: "api-0", values: expect.objectContaining({ SANDBOX_MODE: "pod", AWS_SECRET_ACCESS_KEY: "[redacted]" }),
        }));
        expect(observations).toContainEqual(expect.objectContaining({
          kind: "file-configuration", path: "/etc/secret.yaml", pod: "api-0", values: expect.objectContaining({
            "runtime.sandbox.sidecars[0].env.SNAPSHOT_S3_ENDPOINT": "https://storage.example",
            "runtime.sandbox.sidecars[0].env.AWS_SECRET_ACCESS_KEY": "[redacted]",
          }),
        }));
        expect(fileReads).toBe(1);
        return;
      }
      await runCollectInspect({ namespace: "demo", services: ["api"], field: scenario === "env-only" ? "env" : "config",
        search: "SaNdBoX", config, format: "summary" }, plugin, context, executor);
      const artifact = context.artifacts.list()[0]!;
      const diagnosis: InspectDiagnosis = JSON.parse(readFileSync(join(artifact.path, "diagnosis.json"), "utf8"));
      const search = diagnosis.evidence.search!;
      if (scenario === "env-only") {
        expect(resolutions).toBe(0); expect(fileReads).toBe(0); expect(search.matches).toHaveLength(1); return;
      }
      expect(search.field).toBe("config");
      if (search.field !== "config") throw new Error("expected config field");
      if (scenario !== "denied") expect(search.matches.some(match => match.name === "SANDBOX_MODE")).toBe(true);
      const gap = diagnosis.findings.find(item => item.kind === "evidence.insufficient" && "subject" in item && item.subject === "file-configuration");
      expect(Boolean(gap), JSON.stringify(diagnosis.evidence.observations)).toBe(!["group-ok", "ok", "empty"].includes(scenario));
      if (scenario !== "denied") { expect(fileReads).toBe(1); expect(resolutions).toBe(1); }
      if (grouped) {
        const files = diagnosis.evidence.observations.filter(item => item.kind === "file-configuration");
        expect(files).toHaveLength(2);
        expect(files.map(item => item.status)).toEqual(["collected", scenario === "group-ok" ? "collected" : "unavailable"]);
        expect(files.map(item => item.path)).toEqual(paths);
        expect(new Set(files.map(item => item.id)).size).toBe(2);
      }
      if (scenario === "ok" || grouped) {
        expect(search.matches).toContainEqual({ name: "sandbox.provider.config.endpoint", value: "http://sandbox.example:8080",
          source: "file", service: "api", workload: "api", namespace: "demo", pod: "api-0", container: "main", path: "/etc/config.yaml" });
        expect(diagnosis.evidence.observations.some(item => item.kind === "container-environment" && item.values.OTHER === "keep-in-evidence")).toBe(true);
      }
      expect(JSON.stringify(diagnosis)).not.toContain("private-value");
      expect(JSON.stringify(diagnosis)).not.toContain("private-error-line");
      if (scenario === "denied") expect(fileReads).toBe(0);
    } finally {
      await context.disposeClients();
      for (const artifact of context.artifacts.list()) rmSync(dirname(artifact.path), { recursive: true, force: true });
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
