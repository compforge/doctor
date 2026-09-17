import { expect, test } from "bun:test";
import type { Workload } from "@compforge/doctor-plugin";
import type { Executor, ExecResult } from "@compforge/harness-toolbox/kubernetes/executor";
import { resolveKubernetesWorkload } from "../src/infra/k8s/workload-config";

const snapshot = { services: [], deployments: [], configMaps: [], pods: [] };
function fixture(responses: Record<string, unknown>) {
  const calls: string[][] = [];
  const captures: ExecResult[] = [];
  const executor: Executor = {
    run: async args => {
      calls.push(args);
      const value = responses[args.join(" ")];
      if (!value) throw new Error("Unexpected request: " + args.join(" "));
      return { ok: true, stdout: JSON.stringify(value), stderr: "", exitCode: 0,
        timedOut: false, durationMs: 1, command: args };
    },
    exec: async () => { throw new Error("Discovery must not exec"); },
  };
  return { calls, captures, resolve: (workload: Workload) => resolveKubernetesWorkload(
    snapshot, workload, executor, "demo", "test", result => { captures.push(result); },
  ) };
}
const pod = (name: string, uid = name + "-uid") => ({
  metadata: { name, uid, namespace: "demo" }, spec: { containers: [{ name: "app" }] },
});

test("Pod selector Workload uses common instance identity, not a same-name Service", async () => {
  const fixtureData = fixture({
    "get pods -l app=asandbox,type=carrier -o json": { items: [pod("carrier-1")] },
  });
  const resolved = await fixtureData.resolve({
    name: "carrier", platform: "kubernetes", container: "app",
    location: { kind: "labels", labels: { app: "asandbox", type: "carrier" } },
  });
  expect(resolved.unavailableReason).toBeUndefined();
  expect(resolved.instances).toEqual([{
    platform: "kubernetes", environment: "test", workload: "carrier",
    namespace: "demo", pod: "carrier-1", uid: "carrier-1-uid", container: "app",
  }]);
  expect(resolved.pods.map(item => item.name)).toEqual(["carrier-1"]);
  expect(fixtureData.captures).toHaveLength(1);
});

test("Kubernetes Service location uses the declared resource name", async () => {
  const f = fixture({
    "get services api-v2 -o json": { metadata: { name: "api-v2", namespace: "demo" }, spec: { selector: { app: "api" } } },
    "get pods -l app=api -o json": { items: [pod("api-1")] },
  });
  const resolved = await f.resolve({ name: "main", platform: "kubernetes", location: { kind: "service", name: "api-v2" } });
  expect(resolved.service?.name).toBe("api-v2");
  expect(resolved.instances[0]?.pod).toBe("api-1");
});

test("Resource selector expressions are resolved by toolbox, not a Doctor selector dialect", async () => {
  const f = fixture({
    "get deployments api -o json": { metadata: { name: "api" }, spec: { selector: {
      matchExpressions: [{ key: "role", operator: "In", values: ["api", "worker"] }],
    } } },
    "get pods -l role in (api,worker) -o json": { items: [pod("api-2")] },
  });
  const resolved = await f.resolve({ name: "main", platform: "kubernetes",
    location: { kind: "resource", resource_kind: "Deployment", name: "api" } });
  expect(resolved.unavailableReason).toBeUndefined();
  expect(resolved.instances[0]?.uid).toBe("api-2-uid");
});

test("Missing Pod UID is unavailable rather than inventing a stable identity", async () => {
  const f = fixture({ "get pods only -o json": pod("only", "") });
  const resolved = await f.resolve({ name: "main", platform: "kubernetes",
    location: { kind: "resource", resource_kind: "Pod", name: "only" } });
  expect(resolved.instances).toEqual([]);
  expect(resolved.unavailableReason).toBeDefined();
});

test("Namespace-bound inspection never silently reads a different declared namespace", async () => {
  const f = fixture({});
  const resolved = await f.resolve({ name: "main", platform: "kubernetes", namespace: "other",
    location: { kind: "service", name: "api" } });
  expect(resolved.unavailableReason).toContain("--namespace other");
  expect(f.calls).toEqual([]);
});

test("Pod discovery failure does not discard independently collected Deployment configuration", async () => {
  const deployment = { name: "api", labels: { app: "api" }, containers: [] };
  const executor: Executor = {
    run: async args => ({
      command: args, durationMs: 1, timedOut: false,
      ok: args[1] === "services", exitCode: args[1] === "services" ? 0 : 1,
      stdout: args[1] === "services" ? JSON.stringify({
        metadata: { name: "api-svc", namespace: "demo" }, spec: { selector: { app: "api" } },
      }) : "", stderr: args[1] === "pods" ? "pods forbidden" : "",
    }),
    exec: async () => { throw new Error("No exec"); },
  };
  const result = await resolveKubernetesWorkload({ ...snapshot, deployments: [deployment] }, {
    name: "main", platform: "kubernetes", location: { kind: "service", name: "api-svc" },
  }, executor, "demo", "test", () => {});
  expect(result.unavailableReason).toBe("pods forbidden");
  expect(result.instances).toEqual([]);
  expect(result.deployments).toEqual([deployment]);
});
