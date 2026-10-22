import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createServiceCatalog, fileDataSource, type ServiceDefinition } from "@compforge/doctor-plugin";
import type { Executor, ExecResult } from "@compforge/harness-toolbox/kubernetes/executor";
import { CommandContext } from "../src/command";
import { examplePlugin } from "../../plugins/example/src";
import { runCollectInspect, type InspectDiagnosis, type InspectField } from "../src/collect/inspect";
import { validateInspectInput } from "../src/collect/inspect/options";

const response = (stdout: string): ExecResult => ({ ok: true, stdout, stderr: "", exitCode: 0, timedOut: false, durationMs: 1, command: [] });
const cases: { field: InspectField; mode: string; search?: string }[] = [
  ...(["env", "config", "image", "event", "hpa"] as const).map(field => ({ field, mode: "ok" })),
  { field: "event", mode: "ok", search: "uNhEaLtHy" }, { field: "hpa", mode: "ok", search: "CpU" },
  { field: "event", mode: "ok", search: "missing" }, { field: "hpa", mode: "ok", search: "missing" },
  { field: "hpa", mode: "no-pods" }, { field: "hpa", mode: "statefulset" }, { field: "hpa", mode: "other-namespace" }, { field: "event", mode: "truncated" },
  ...(["event", "hpa"] as const).flatMap(field => ["empty", "denied", "invalid"].map(mode => ({ field, mode }))),
];

/** @case id=inspect_field_scope,desc=Each field requests only its own evidence and target discovery; failed reads never become empty success. */
for (const { field, mode, search } of cases) test(`Inspect ${field} limits collection, permissions and coverage: ${mode}/${search ?? "all"}`, async () => {
  const directory = mkdtempSync(join(tmpdir(), "inspect-fields-"));
  const config = join(directory, "profile.yaml"); writeFileSync(config, "");
  const calls: string[][] = [], commands: string[][] = [];
  let fileResolutions = 0;
  const file = fileDataSource(["/config.yaml"], { workload: "main", access: { kubernetes: [{
    rule: { verb: "create", resource: "pods/exec" }, requirement: "required", purpose: "configuration",
  }] }, resolve: async () => { fileResolutions++; return { namespace: "demo", pod: "api-0", container: "main" }; } });
  const service: ServiceDefinition = { name: "api", component: { name: "api", repository: { forge: { name: "test" }, path: "api" } },
    workloads: [{ name: "main", platform: "kubernetes", namespace: mode === "other-namespace" ? "other" : undefined, container: "main", location: { kind: "resource", resource_kind: mode === "statefulset" ? "StatefulSet" : "Deployment", name: "api" } }],
    dataSources: [file], environmentProbes: [{ id: "admission", kind: "kubernetes.apparmor-unconfined-admission", schemaVersion: 1, subject: "workload-service-account" }] };
  const plugin = { ...examplePlugin, services: createServiceCatalog([service]) };
  const executor: Executor = {
    run: async args => {
      calls.push([...args]);
      if (args[0] === "config") return response("test\nhttps://cluster.test");
      if (args[0] === "auth") return response("yes");
      if (args[0] !== "get") throw new Error(`Unrelated operation: ${args.join(" ")}`);
      if (args[1] === "deployments" || args[1] === "statefulsets") {
        expect(args[2]).toBe("api"); // Named resource discovery is required; Deployment configuration lists are not.
        return response(JSON.stringify({ metadata: { name: "api" }, spec: { selector: { matchLabels: { app: "api" } } } }));
      }
      if (args[1] === "pods") return response(JSON.stringify({ items: mode === "no-pods" ? [] : [{
        metadata: { name: "api-0", namespace: "demo", uid: "uid", labels: { app: "api" } },
        spec: { containers: [{ name: "main", image: "image:v1" }] }, status: { phase: "Running" },
      }] }));
      const resource = field === "event" ? "events" : "horizontalpodautoscalers";
      expect(args[1]).toBe(resource);
      if (mode === "denied") return { ...response(""), ok: false, exitCode: 1, stderr: "field access denied" };
      if (mode === "invalid") return response('{"items":"invalid"}');
      const event = { type: "Warning", reason: "Unhealthy", message: "probe failed", involvedObject: { kind: "Pod", name: "api-0" }, lastTimestamp: "2026-10-21T00:00:00Z" };
      const hpa = { metadata: { name: "api-scale" }, spec: { scaleTargetRef: { kind: mode === "statefulset" ? "StatefulSet" : "Deployment", name: "api" }, minReplicas: 1, maxReplicas: 4,
        metrics: [{ resource: { name: "cpu", target: { averageUtilization: 80 } } }] }, status: { currentReplicas: 2, desiredReplicas: 3 } };
      return response(JSON.stringify({ items: mode === "empty" ? [] : args[1] === "events"
        ? [...Array.from({ length: mode === "truncated" ? 201 : 1 }, () => event), { ...event, involvedObject: { kind: "Pod", name: "unrelated" } }]
        : [hpa, { ...hpa, metadata: { name: "same-name-other-kind" }, spec: { ...hpa.spec, scaleTargetRef: { kind: mode === "statefulset" ? "Deployment" : "StatefulSet", name: "api" } } }, { ...hpa, metadata: { name: "other-scale" }, spec: { ...hpa.spec, scaleTargetRef: { kind: "Deployment", name: "other" } } }] }));
    },
    exec: async (_target, command, options) => {
      commands.push(command);
      if (command[0] === "printenv") return response("SANDBOX_MODE=pod\0");
      expect(field).toBe("config");
      const content = Buffer.concat([Buffer.from("sandbox: true"), Buffer.from([0]), Buffer.from("000")]);
      options?.onStdoutBytes?.(Buffer.from(`0 ${content.toString("base64")}\n`));
      return response("");
    },
  };
  const context = new CommandContext({}, undefined, { plugin });
  try {
    await runCollectInspect({ namespace: "demo", services: ["api"], field, search, config, format: "summary" }, plugin, context, executor);
    const artifact = context.artifacts.list()[0]!;
    const diagnosis: InspectDiagnosis = JSON.parse(readFileSync(join(artifact.path, "diagnosis.json"), "utf8"));
    expect(calls.some(args => args[0] === "get" && args[1] === "events")).toBe(field === "event");
    expect(calls.some(args => args[0] === "get" && args[1] === "horizontalpodautoscalers")).toBe(field === "hpa");
    expect(calls.some(args => args.includes("events") && args[0] === "auth")).toBe(field === "event");
    expect(calls.some(args => args.includes("horizontalpodautoscalers.autoscaling") && args[0] === "auth")).toBe(field === "hpa");
    expect(calls.some(args => args.includes("configmaps"))).toBe(false);
    expect(commands).toHaveLength(field === "config" ? 2 : field === "env" ? 1 : 0);
    expect(fileResolutions).toBe(field === "config" ? 1 : 0);
    expect(diagnosis.evidence.observations.every(item => item.kind === "container-environment" || item.kind === "file-configuration")).toBe(true);
    expect(diagnosis.coverage.map(item => item.goal)).toEqual(field === "config" ? ["workload-runtime", "container-environment", "file-configuration"]
      : field === "image" ? ["workload-runtime"] : ["workload-runtime", field === "env" ? "container-environment" : field]);
    if (field === "event" || field === "hpa") {
      const coverage = diagnosis.coverage.find(item => item.goal === field)!;
      expect(coverage.status).toBe(mode === "denied" || mode === "invalid" ? "insufficient" : mode === "truncated" ? "partial" : "sufficient");
      const matches = diagnosis.evidence.search!.matches;
      expect(matches).toHaveLength(mode === "truncated" ? 200 : mode === "empty" || mode === "denied" || mode === "invalid" || mode === "other-namespace" || search === "missing" ? 0 : 1);
      const summary = readFileSync(join(artifact.path, "summary.md"), "utf8");
      expect(summary).toContain(`# Inspect ${field}`);
      expect(summary).not.toContain("unrelated"); expect(summary).not.toContain("other-scale"); expect(summary).not.toContain("same-name-other-kind");
      if (mode === "denied") expect(summary).toContain("field access denied");
      if (mode === "invalid") expect(summary).toContain("响应解析失败");
      if (mode === "truncated") expect(summary).toContain("省略 1 条事件");
      if (field === "hpa" && matches.length) expect(summary).toContain("cpu: ?%/80%");
    }
  } finally {
    await context.disposeClients();
    for (const artifact of context.artifacts.list()) rmSync(dirname(artifact.path), { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

test("field selection rejects extra collection flags before environment access", () => {
  for (const field of ["env", "config", "image", "event", "hpa"] as const) {
    expect(() => validateInspectInput({ services: ["api"], field, dependencies: true })).toThrow("只采集所选字段");
    expect(() => validateInspectInput({ services: ["api"], field, deploymentConfig: true })).toThrow("只采集所选字段");
  }
  expect(() => validateInspectInput({ services: ["api"], search: "sandbox", dependencies: true })).toThrow("只采集所选字段");
});
