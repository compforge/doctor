import { expect, spyOn, test } from "bun:test";
import { createServiceCatalog, type ServiceDefinition } from "@compforge/doctor-plugin";
import type { Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import { CommandContext } from "../src/command";
import { validateHealthOptions } from "../src/health";
import { healthProviders } from "../src/health/extensions";
import { S3HealthSession, validateHealthS3SourceSelection } from "../src/health/s3/runtime";
import * as parameters from "../src/terminal/parameters";
import * as pods from "../src/infra/k8s/pod-selection";
import * as containers from "../src/infra/k8s/container-selection";

function service(name: string): ServiceDefinition {
  return { name, component: { name, repository: { forge: { name: "test" }, path: name } },
    workloads: [{ name: "main", platform: "kubernetes", location: { kind: "labels", labels: { app: name } } }],
    dataSources: [{ id: "s3", kind: "s3", backend: "s3-compatible", environment: {
      endpoint: "ENDPOINT", bucket: "BUCKET", region: "REGION", accessKey: "AK", secretKey: "SK" } }] };
}

for (const scenario of ["explicit", "interactive", "cancel-pod", "cancel-container", "ambiguous-pod", "ambiguous-container", "invalid-pod", "invalid-container", "assume-yes"] as const) {
  test(`S3 Workload configuration selection: ${scenario}`, async () => {
    const calls: string[] = []; const reads: string[] = []; let content = "";
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
      calls.push(request.method);
      if (request.method === "PUT") { content = await request.text(); return new Response(null); }
      return request.method === "GET" ? new Response(content) : new Response(null, { status: 204 });
    } });
    const selected = service("files");
    const plugin = { id: "test", version: "1", services: createServiceCatalog([selected]) };
    const command = new CommandContext({}, undefined, { plugin, yes: scenario === "assume-yes" || scenario === "explicit" });
    const interactive = spyOn(parameters, "canPrompt").mockReturnValue(["interactive", "cancel-pod", "cancel-container", "assume-yes"].includes(scenario));
    const pod = spyOn(pods, "promptPod").mockResolvedValue(scenario === "cancel-pod" ? undefined : "files-2");
    const container = spyOn(containers, "promptContainer").mockResolvedValue(scenario === "cancel-container" ? undefined : "app");
    const env = Object.entries({ ENDPOINT: `http://127.0.0.1:${server.port}`, BUCKET: "bucket", REGION: "region-1", AK: "fixture", SK: "secret" })
      .map(([name, value]) => ({ name, value }));
    const executor: Executor = {
      run: async args => {
        let stdout: string;
        if (args[0] === "config") stdout = "fixture\nhttps://kubernetes.test";
        else if (args[1] === "pods") stdout = JSON.stringify({ items: ["files-1", "files-2"].map(name => ({
          metadata: { name, uid: name, namespace: "test" }, status: { phase: "Running" },
          spec: { containers: [{ name: "sidecar" }, { name: "app" }] },
        })) });
        else if (args[1] === "pod") {
          reads.push(args[2]!); expect(args[2]).toBe("files-2");
          stdout = JSON.stringify({ spec: { containers: [{ name: "sidecar", env: [] }, { name: "app", env }] } });
        } else throw new Error(`Unexpected Kubernetes command: ${args.join(" ")}`);
        return { command: args, ok: true, exitCode: 0, stdout, stderr: "", durationMs: 1, timedOut: false };
      },
      exec: async () => { throw new Error("Configuration must come from selected app container declaration"); },
    };
    const selection = scenario === "explicit" ? { pod: "files-2", container: "app" }
      : scenario === "invalid-pod" ? { pod: "missing" }
      : scenario === "invalid-container" ? { pod: "files-2", container: "missing" }
      : scenario === "ambiguous-container" ? { pod: "files-2" } : {};
    try {
      const [check] = await new S3HealthSession(command,
        { profileName: "fixture", kubernetes: { namespace: "test", namespaceSource: "flag", kubeconfigSource: "flag" } },
        executor, selection).check(healthProviders(plugin)[0]!, () => {});
      if (scenario === "explicit") {
        expect(check?.status, check?.reason).toBe("passed");
        expect(calls).toEqual(["PUT", "GET", "DELETE"]);
        expect(reads).toEqual(["files-2"]);
        expect(content).toBe("hello world");
        expect(pod).not.toHaveBeenCalled(); expect(container).not.toHaveBeenCalled();
      } else if (scenario === "interactive") {
        // A noninteractive test terminal denies the separate write approval after selection succeeds.
        expect(reads).toEqual(["files-2"]);
        expect(check?.reason).toContain("-y/--yes");
        expect(pod).toHaveBeenCalledTimes(1); expect(container).toHaveBeenCalledTimes(1);
        expect(calls).toEqual([]);
      } else {
        expect(check?.status).toBe(scenario.startsWith("cancel") ? "cancelled" : "unavailable");
        expect(check?.reason).toContain(scenario.startsWith("cancel") ? "已取消 S3 配置来源选择"
          : scenario.startsWith("invalid") ? "missing" : scenario === "ambiguous-container" ? "--container" : "--pod");
        expect(reads).toEqual([]); expect(calls).toEqual([]);
        if (scenario === "assume-yes") { expect(pod).not.toHaveBeenCalled(); expect(container).not.toHaveBeenCalled(); }
      }
    } finally {
      container.mockRestore(); pod.mockRestore(); interactive.mockRestore();
      server.stop(true); await command.disposeClients();
    }
  });
}

test("Health instance selectors require one configuration owner and nonempty names", () => {
  const a = service("a"), b = service("b");
  const consumer: ServiceDefinition = { ...service("consumer"), dataSources: [], dependencies: [
    { id: "a", service: "a", dataSource: "s3" }, { id: "b", service: "b", dataSource: "s3" },
  ] };
  const plugin = { id: "test", version: "1", services: createServiceCatalog([a, b, consumer]) };
  expect(() => validateHealthS3SourceSelection(healthProviders(plugin), plugin, { pod: "a-1" })).toThrow("--service");
  expect(() => validateHealthS3SourceSelection(healthProviders(plugin, ["consumer"]), plugin, { container: "app" })).toThrow("--service");
  expect(() => validateHealthS3SourceSelection(healthProviders(plugin, ["a"]), plugin, { pod: "a-1" })).not.toThrow();
  expect(() => validateHealthS3SourceSelection([], plugin, { pod: "a-1" })).toThrow("--scope infra");
  expect(() => validateHealthS3SourceSelection(healthProviders(plugin), plugin, {})).not.toThrow();
  for (const name of ["pod", "container"] as const) expect(() => validateHealthOptions({ [name]: " " })).toThrow(`--${name} 需要非空名称`);
});
