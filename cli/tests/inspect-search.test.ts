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
import type { ConfigSearchMatch, ContainerEnvironmentObservation, InspectDiagnosis, InspectFacts } from "../src/collect/inspect/model";
import { unavailableFact } from "../src/collect/protocol";

const facts: InspectFacts = {
  serviceTargets: unavailableFact("inspect.service-targets", "test", "fixture"),
  deploymentConfiguration: unavailableFact("inspect.deployment-configuration", "test", "fixture"),
  dependencyTargets: unavailableFact("inspect.dependency-targets", "test", "not requested"),
  lifecycleSignals: unavailableFact("inspect.lifecycle-signals", "test", "fixture"),
};
const observation = (pod: string, values: Record<string, string>): ContainerEnvironmentObservation => ({
  id: pod, kind: "container-environment", schemaVersion: 1,
  producer: { origin: "core", id: "container-environment" },
  service: "api", workload: "api", pod, container: "main", status: "collected", values,
});
const evidence = buildInspectEvidence([
  observation("api-a", { SANDBOX_ENDPOINT: "http://compute-a:80", SERVICE_URL: "http://SandBox-B:80", LOG_LEVEL: "info" }),
  observation("api-b", { SANDBOX_ENDPOINT: "http://compute-c:80", LITERAL: "a.b[0]", AUTH: "[secretKeyRef:auth/token]" }),
  { id: "declaration", kind: "environment-config", schemaVersion: 1, producer: { origin: "core", id: "environment-config" },
    service: "api", deployment: "api", container: "main", values: { SANDBOX_ONLY_DECLARED: "should-not-match", LOG_LEVEL: "declaration" } },
], facts);

test("Env search matches names and values case-insensitively and preserves each source", () => {
  const result = searchInspectFields(evidence, "env", "sAnDbOx");
  if (result.field !== "env") throw new Error("expected env result");
  expect(result.matches.map(item => [item.name, item.value, item.pod, item.container])).toEqual([
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
  expect(evidence.observations).toHaveLength(3);
  expect(searchInspectFields(evidence, "env", "should-not-match").matches).toEqual([]);
  expect(evidence.observations[0]).toMatchObject({ values: { LOG_LEVEL: "info" } });
  expect(evidence.search).toBeUndefined();
});

test("search rejects empty keywords and allows Pod Env without deployment configuration", () => {
  expect(() => validateInspectInput({ services: ["api"], search: "   " })).toThrow("--search 不能为空");
  expect(() => validateInspectInput({ services: ["api"], search: "env", deploymentConfig: false })).not.toThrow();
  expect(() => validateInspectInput({ services: ["api"], search: "env" })).not.toThrow();
  expect(createInspectInput({ services: ["api"], search: "a" }).idempotencyKey?.())
    .not.toBe(createInspectInput({ services: ["api"], search: "b" }).idempotencyKey?.());
});

test("search reports filtered values and distinguishes an empty result from missing evidence", () => {
  const diagnosis: InspectDiagnosis = {
    evidence: { ...evidence, search: searchInspectFields(evidence, "env", "sandbox") }, findings: [],
    coverage: [{ goal: "container-environment", status: "sufficient", missingEvidence: [] }],
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
  diagnosis.coverage = [{ goal: "container-environment", status: "insufficient", missingEvidence: ["pods/exec denied"] }];
  expect(buildInspectSummary(diagnosis)).toContain("未匹配不代表目标值不存在");
  expect(buildInspectSummary(diagnosis)).toContain("pods/exec denied");
});


for (const scenario of [
  { field: undefined, search: "sAnDbOx", configuration: false, count: 2 },
  { field: "env" as const, search: undefined, configuration: false, count: 3 },
  { field: "env" as const, search: "missing", configuration: false, count: 0 },
  { field: "image" as const, search: undefined, configuration: false, count: 1 },
  { field: "image" as const, search: "IMAGE:v2", configuration: false, count: 1 },
  { field: "image" as const, search: "SHA256:ABCD", configuration: false, count: 1 },
  { field: "image" as const, search: "missing", configuration: false, count: 0 },
  { field: "env" as const, search: "missing", configuration: false, count: 0, failExec: true },
]) {
  test(`inspect field=${scenario.field ?? "implicit"} search=${scenario.search ?? "all"} failed=${!!scenario.failExec}`, async () => {
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
      exec: async (target, command) => {
        expect(command).toEqual(["printenv", "-0"]);
        expect(target).toEqual({ pod: "api-0", container: "main" });
        if (scenario.failExec) return { ...response(""), ok: false, exitCode: 1, stderr: "pods/exec denied" };
        return response("SANDBOX_MODE=actual-pod\0OTHER_URL=http://SandBox.test\0LOG_LEVEL=runtime\0");
      },
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
      if (result.field === "env" || result.field === "image" || result.field === "config") {
        expect(result.matches.every(item => item.service === "example-api" && item.container === "main")).toBe(true);
      }
      const summary = readFileSync(join(artifact.path, "summary.md"), "utf8");
      if (scenario.failExec) {
        expect(summary).toContain("证据不完整");
        expect(summary).toContain("pods/exec denied");
      } else {
        expect(summary).toContain("采集完整");
      }
      if (result.field === "env" && !scenario.failExec) {
        expect(diagnosis.evidence.observations.some(item => item.kind === "container-environment"
          && item.values.LOG_LEVEL === "runtime")).toBe(true);
        expect(result.matches.every(item => item.pod === "api-0")).toBe(true);
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


const configMatch = (pod: string, name: string, value: ConfigSearchMatch["value"]): ConfigSearchMatch => ({
  service: "api", namespace: "qa", workload: pod, pod, container: "main", source: "file", path: "/config.yaml", name, value,
});
const configDiagnosis = (matches: ConfigSearchMatch[]): InspectDiagnosis => ({
  evidence: { ...evidence, search: { field: "config", keyword: "sandbox", matches } }, findings: [],
  coverage: ["container-environment", "file-configuration"].map(goal => ({
    goal: goal as "container-environment" | "file-configuration", status: "sufficient", missingEvidence: [],
  })),
});

test("Config Markdown uses one table for identical query matches and retains each origin and differing values", () => {
  const diagnosis = configDiagnosis([
    configMatch("gateway-a", "sandbox.endpoint", "https://compute-a"), configMatch("gateway-a", "sandbox.enabled", true),
    configMatch("worker-a", "sandbox.enabled", true), configMatch("worker-a", "sandbox.endpoint", "https://compute-a"),
    configMatch("worker-b", "sandbox.endpoint", "https://compute-b"), configMatch("worker-b", "sandbox.enabled", true),
  ]);
  const before = JSON.stringify(diagnosis);
  const summary = buildInspectSummary(diagnosis, "qa");
  expect(summary.match(/\| 名称 \| 值 \|/g)).toHaveLength(2);
  expect(summary.match(/\| sandbox.endpoint \|/g)).toHaveLength(2);
  expect(summary).toContain("匹配项：6；采集完整");
  expect(summary).toContain("https://compute-a"); expect(summary).toContain("https://compute-b");
  for (const pod of ["gateway-a", "worker-a", "worker-b"]) expect(summary).toContain(`Pod：${pod}`);
  expect(summary).not.toContain("| Workload |");
  expect(JSON.stringify(diagnosis)).toBe(before);
});

test("Config groups keep file/env, Service, namespace, path and value types separate", () => {
  const base = configMatch("api-a", "sandbox.limit", 80);
  const summary = buildInspectSummary(configDiagnosis([
    base, { ...base, pod: "api-b", value: "80" }, { ...base, path: "/overlay.yaml" },
    { ...base, source: "env", path: undefined, namespace: undefined },
    { ...base, service: "other" }, { ...base, namespace: "production" },
  ]), "qa");
  expect(summary.match(/\| 名称 \| 值 \|/g)).toHaveLength(6);
  expect(summary).toContain("## Pod env\n\n- Service：api\n- Namespace：qa");
  expect(summary).toContain("## 文件：/overlay.yaml");
  expect(summary).toContain("Namespace：production");
});

test("Grouped Config Markdown preserves escaping and empty-result coverage", () => {
  const diagnosis = configDiagnosis([configMatch("api-a", "sandbox.<key>", "a|b\n<c>")]);
  expect(buildInspectSummary(diagnosis)).toContain("| sandbox.&lt;key&gt; | a\\|b<br>&lt;c&gt; |");
  diagnosis.evidence.search = { field: "config", matches: [] };
  diagnosis.coverage = [{ goal: "file-configuration", status: "insufficient", missingEvidence: ["unreadable file"] }];
  const empty = buildInspectSummary(diagnosis);
  expect(empty).toContain("未找到匹配的 config");
  expect(empty).toContain("未匹配不代表目标值不存在");
  expect(empty).toContain("unreadable file");
  expect(empty).not.toContain("| 名称 | 值 |");
});
