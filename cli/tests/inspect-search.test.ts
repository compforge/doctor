// Exercise the real Inspect collection path with a bounded Kubernetes fixture.
import { examplePlugin } from "../../plugins/example/src";
import { CommandContext } from "../src/command";
import { runCollectInspect } from "../src/collect/inspect";
import type { ExecResult, Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { expect, test } from "bun:test";
import { buildInspectEvidence, searchInspectFields } from "../src/collect/inspect/detector";
import { buildInspectHtml, buildInspectHtmlSections, buildInspectSummary } from "../src/collect/inspect/render";
import { validateInspectInput } from "../src/collect/inspect/options";
import { createInspectInput } from "../src/collect/inspect/command";
import type { EnvironmentConfigObservation, InspectDiagnosis, InspectFacts } from "../src/collect/inspect/model";
import { unavailableFact } from "../src/collect/protocol";

const facts: InspectFacts = {
  serviceTargets: unavailableFact("inspect.service-targets", "test", "fixture"),
  deploymentConfiguration: unavailableFact("inspect.deployment-configuration", "test", "fixture"),
  dependencyTargets: unavailableFact("inspect.dependency-targets", "test", "not requested"),
  lifecycleSignals: unavailableFact("inspect.lifecycle-signals", "test", "fixture"),
};
const observation = (deployment: string, values: Record<string, string>): EnvironmentConfigObservation => ({
  id: deployment, kind: "environment-config", schemaVersion: 1,
  producer: { origin: "core", id: "environment-config" },
  service: "api", deployment, container: "main", values,
});
const evidence = buildInspectEvidence([
  observation("api-a", { SANDBOX_ENDPOINT: "http://compute-a:80", SERVICE_URL: "http://SandBox-B:80", LOG_LEVEL: "info" }),
  observation("api-b", { SANDBOX_ENDPOINT: "http://compute-c:80", LITERAL: "a.b[0]", AUTH: "[secretKeyRef:auth/token]" }),
], facts);

test("Env search matches names and values case-insensitively and preserves each source", () => {
  const result = searchInspectFields(evidence, "env", "sAnDbOx");
  if (result.field !== "env") throw new Error("expected env result");
  expect(result.matches.map(item => [item.name, item.value, item.deployment, item.container])).toEqual([
    ["SANDBOX_ENDPOINT", "http://compute-a:80", "api-a", "main"],
    ["SERVICE_URL", "http://SandBox-B:80", "api-a", "main"],
    ["SANDBOX_ENDPOINT", "http://compute-c:80", "api-b", "main"],
  ]);
  expect(result.matches.every(item => item.service === "api")).toBe(true);
  expect(searchInspectFields(evidence, "env", "COMPUTE-C").matches).toHaveLength(1);
  expect(searchInspectFields(evidence, "env", "b[0]").matches).toHaveLength(1);
  expect(searchInspectFields(evidence, "env", ".*").matches).toEqual([]);
  expect(searchInspectFields(evidence, "env", "sandbox compute").matches).toEqual([]);
  expect(searchInspectFields(evidence, "env", "secretkeyref").matches[0]).toMatchObject({ value: "[secretKeyRef:auth/token]" });
  expect(evidence.observations).toHaveLength(2);
  expect(evidence.rows.some(item => item.name === "LOG_LEVEL")).toBe(true);
  expect(evidence.search).toBeUndefined();
});

test("search rejects empty keywords and conflicting config scope before access", () => {
  expect(() => validateInspectInput({ services: ["api"], search: "   " })).toThrow("--search 不能为空");
  expect(() => validateInspectInput({ services: ["api"], search: "env", deploymentConfig: false })).toThrow("--no-deployment-config");
  expect(() => validateInspectInput({ services: ["api"], search: "env" })).not.toThrow();
  expect(createInspectInput({ services: ["api"], search: "a" }).idempotencyKey?.())
    .not.toBe(createInspectInput({ services: ["api"], search: "b" }).idempotencyKey?.());
});

test("search reports filtered values and distinguishes an empty result from missing evidence", () => {
  const diagnosis: InspectDiagnosis = {
    evidence: { ...evidence, search: searchInspectFields(evidence, "env", "sandbox") }, findings: [],
    coverage: [{ goal: "environment-config", status: "sufficient", missingEvidence: [] }],
  };
  const summary = buildInspectSummary(diagnosis, "qa");
  expect(summary).toContain("http://SandBox-B:80");
  expect(summary).toContain("api-a");
  expect(summary).not.toContain("LOG_LEVEL");
  expect(buildInspectHtml(diagnosis)).toContain("匹配项：3");
  expect(buildInspectHtmlSections(diagnosis)[0]?.html).toContain("http://compute-c:80");
  diagnosis.evidence.search = searchInspectFields(evidence, "env", "missing");
  expect(buildInspectSummary(diagnosis)).toContain("采集完整");
  expect(buildInspectSummary(diagnosis)).toContain("未找到匹配的 env");
  diagnosis.coverage = [{ goal: "environment-config", status: "insufficient", missingEvidence: ["ConfigMap read failed"] }];
  expect(buildInspectSummary(diagnosis)).toContain("未匹配不代表目标值不存在");
  expect(buildInspectSummary(diagnosis)).toContain("ConfigMap read failed");
});


for (const scenario of [
  { field: undefined, search: "sAnDbOx", configuration: true, count: 2 },
  { field: "env" as const, search: undefined, configuration: true, count: 3 },
  { field: "env" as const, search: "missing", configuration: true, count: 0 },
  { field: "image" as const, search: undefined, configuration: false, count: 1 },
  { field: "image" as const, search: "IMAGE:v2", configuration: false, count: 1 },
  { field: "image" as const, search: "SHA256:ABCD", configuration: false, count: 1 },
  { field: "image" as const, search: "missing", configuration: false, count: 0 },
  { field: "env" as const, search: "missing", configuration: true, count: 0, failConfig: true },
]) {
  test(`inspect field=${scenario.field ?? "implicit"} search=${scenario.search ?? "all"} failed=${!!scenario.failConfig}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "inspect-search-test-"));
    const config = join(dir, "config.yaml");
    writeFileSync(config, "");
    const context = new CommandContext({});
    const calls: string[][] = [];
    const response = (stdout: string): ExecResult => ({ ok: true, exitCode: 0, stdout, stderr: "", durationMs: 1, timedOut: false, command: ["kubectl"] });
    const resources: Record<string, Array<{ metadata?: { name: string; labels?: Record<string, string>; [key: string]: unknown }; [key: string]: unknown }>> = {
      services: [{ metadata: { name: "example-api" }, spec: { selector: { app: "example-api" }, ports: [{ port: 80, targetPort: 8080 }] } }],
      pods: [{ metadata: { name: "api-0", namespace: "demo", uid: "uid", labels: { app: "example-api" } },
        spec: { containers: [{ name: "main", image: "registry.test/Image:v2", ports: [{ containerPort: 8080 }] }] },
        status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }],
          containerStatuses: [{ name: "main", imageID: "registry.test/image@sha256:abcd", ready: true, restartCount: 0, state: { running: {} } }] } },
        { metadata: { name: "other-0", namespace: "demo", uid: "other", labels: { app: "other" } },
          spec: { containers: [{ name: "main", image: "do-not-return/Image:v2" }] }, status: { phase: "Running" } }],
      deployments: [{ metadata: { name: "api" }, spec: { template: { metadata: { labels: { app: "example-api" } },
        spec: { containers: [{ name: "main", ports: [{ containerPort: 8080 }],
          envFrom: [{ configMapRef: { name: "api-config" } }], env: [{ name: "OTHER_URL", value: "http://SandBox.test" }] }] } } } }],
      configmaps: [{ metadata: { name: "api-config" }, data: { SANDBOX_MODE: "pod", LOG_LEVEL: "debug" } }],
      events: [], horizontalpodautoscalers: [],
    };
    const executor: Executor = {
      run: async args => {
        calls.push([...args]);
        if (args[0] === "config") return response("test\nhttps://cluster.test");
        const resource = args[1]!;
        if (scenario.failConfig && resource === "configmaps") return { ...response(""), ok: false, exitCode: 1, stderr: "ConfigMap denied" };
        if (resources[resource]) {
          const selectorIndex = args.indexOf("-l");
          const selector = selectorIndex >= 0 ? args[selectorIndex + 1] : undefined;
          const items = resources[resource].filter(item => !selector || selector.split(",").every(pair => {
            const [key, value] = pair.split("=");
            return item.metadata?.labels?.[key!] === value;
          }));
          return response(JSON.stringify(args[2] && !args[2].startsWith("-")
            ? items.find(item => item.metadata?.name === args[2])
            : { items }));
        }
        throw new Error(`Unexpected kubectl: ${args.join(" ")}`);
      },
      exec: async () => { throw new Error("detail queries must not collect dependencies implicitly"); },
    };
    try {
      await runCollectInspect({ namespace: "demo", services: ["example-api"], field: scenario.field,
        search: scenario.search, config, format: "bundle" }, examplePlugin, context, executor);
      const artifact = context.artifacts.list()[0]!;
      const diagnosis: InspectDiagnosis = JSON.parse(readFileSync(join(artifact.path, "diagnosis.json"), "utf8"));
      const result = diagnosis.evidence.search!;
      expect(result.field).toBe(scenario.field ?? "env");
      expect(result.matches).toHaveLength(scenario.count);
      expect(calls.some(args => args[1] === "configmaps")).toBe(scenario.configuration);
      expect(calls.some(args => args[1] === "deployments")).toBe(scenario.configuration);
      expect(JSON.stringify(result)).not.toContain("do-not-return");
      expect(result.matches.every(item => item.service === "example-api" && item.container === "main")).toBe(true);
      const summary = readFileSync(join(artifact.path, "summary.md"), "utf8");
      if (scenario.failConfig) {
        expect(summary).toContain("证据不完整");
        expect(summary).toContain("ConfigMap denied");
      } else {
        expect(summary).toContain("采集完整");
      }
      if (scenario.configuration && !scenario.failConfig) {
        expect(diagnosis.evidence.rows.some(row => row.name === "LOG_LEVEL")).toBe(true);
        if (scenario.search) expect(summary).not.toContain("LOG_LEVEL");
      }
      if (result.field === "image" && result.matches.length) {
        expect(result.matches[0]).toMatchObject({ image: "registry.test/Image:v2", imageId: "registry.test/image@sha256:abcd", pod: "api-0" });
        expect(summary).toContain("registry.test/Image:v2");
      }
    } finally {
      for (const artifact of context.artifacts.list()) rmSync(dirname(artifact.path), { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
