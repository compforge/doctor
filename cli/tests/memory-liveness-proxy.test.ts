import { expect, test } from "bun:test";
import { createServiceCatalog, type PluginDefinition } from "@compforge/doctor-plugin";
import {
  livenessProxyPrereqCmd,
  parseDetachedPid,
  resolveLivenessProxyIntent,
  startLivenessProxyCmd,
} from "../src/collect/memory/liveness-proxy";
import type { KubernetesService } from "../src/infra/k8s/service";
import type { TargetPod } from "../src/infra/k8s/target";

const plugin = {
  id: "test",
  version: "0.0.1",
  services: createServiceCatalog([{
    name: "api",
    capabilities: {
      liveness: {
        httpGet: { path: "/health", port: 8080 },
        heapDumpProxy: { statusCode: 200, body: '{"status":"ok"}' },
      },
    },
  }]),
} as PluginDefinition;

const service: KubernetesService = {
  kind: "service",
  namespace: "default",
  name: "api",
  selector: { app: "api" },
  ports: [{ port: 8080, targetPort: "http" }],
};

function targetPod(overrides: Partial<TargetPod> = {}): TargetPod {
  return {
    name: "api-abc",
    namespace: "default",
    phase: "Running",
    podIP: "10.0.0.8",
    hostNetwork: false,
    labels: { app: "api" },
    containers: [{
      name: "api",
      image: "api:latest",
      restartCount: 0,
      ports: [{ name: "http", containerPort: 8080 }],
      livenessProbe: {
        httpGet: { path: "/health", port: "http" },
        periodSeconds: 10,
        failureThreshold: 3,
      },
    }],
    ...overrides,
  };
}

test("matches an opted-in Plugin liveness contract to the live Pod probe", () => {
  const pod = targetPod();
  expect(resolveLivenessProxyIntent({
    plugin,
    services: [service],
    pod,
    container: pod.containers[0]!,
  })).toEqual({
    intent: {
      service: "api",
      podIP: "10.0.0.8",
      port: 8080,
      path: "/health",
      userAgent: "kube-probe/",
      userAgentExact: false,
      response: { statusCode: 200, body: '{"status":"ok"}' },
    },
  });
});

test("refuses interception when runtime and Plugin liveness contracts differ", () => {
  const pod = targetPod();
  pod.containers[0]!.livenessProbe!.httpGet!.path = "/live";
  expect(resolveLivenessProxyIntent({
    plugin,
    services: [service],
    pod,
    container: pod.containers[0]!,
  }).reason).toContain("与 Plugin 声明");

  const hostPod = targetPod({ hostNetwork: true });
  expect(resolveLivenessProxyIntent({
    plugin,
    services: [service],
    pod: hostPod,
    container: hostPod.containers[0]!,
  }).reason).toContain("hostNetwork");
});

test("builds a bounded detached proxy command without changing the application port", () => {
  const pod = targetPod();
  const resolved = resolveLivenessProxyIntent({
    plugin,
    services: [service],
    pod,
    container: pod.containers[0]!,
  });
  if (!resolved.intent) throw new Error(resolved.reason);
  const started = startLivenessProxyCmd(resolved.intent, "12-test", 960);
  expect(started.guardPath).toBe("/tmp/doctor-pydump/liveness-12-test.json");
  expect(started.command[0]).toBe("python3");
  expect(started.command.join(" ")).toContain("ttl_seconds");
  expect(livenessProxyPrereqCmd("10.0.0.8").at(-1)).toContain("iptables");
  expect(parseDetachedPid({
    ok: true,
    command: [],
    stdout: "123\n",
    stderr: "",
    exitCode: 0,
    durationMs: 1,
    timedOut: false,
  })).toBe(123);
});
