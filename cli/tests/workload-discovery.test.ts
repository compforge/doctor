import { expect, test } from "bun:test";
import { resolveKubernetesWorkload } from "../src/infra/k8s/workload-config";

const pod = (name: string, labels: Record<string, string>) => ({
  kind: "pod" as const,
  namespace: "demo",
  name,
  serviceAccountName: "default",
  phase: "Running",
  conditions: [],
  labels,
  containers: [],
});

test("Pod selector Workload 不依赖同名 Kubernetes Service", () => {
  const resolved = resolveKubernetesWorkload({
    services: [],
    deployments: [],
    configMaps: [],
    pods: [
      pod("carrier-1", { app: "asandbox", type: "bedbox-carrier" }),
      pod("sandbox-server-1", { app: "asandbox", type: "server" }),
    ],
  }, {
    name: "carrier",
    lifecycle: "ephemeral",
    discovery: {
      kind: "kubernetes-pods",
      labels: { app: "asandbox", type: "bedbox-carrier" },
    },
  });

  expect(resolved.unavailableReason).toBeUndefined();
  expect(resolved.pods.map((item) => item.name)).toEqual(["carrier-1"]);
});

test("Kubernetes Service Workload 使用声明的资源名而非业务 Service 名", () => {
  const resolved = resolveKubernetesWorkload({
    services: [{
      kind: "service",
      namespace: "demo",
      name: "api-v2",
      selector: { app: "api" },
      ports: [],
    }],
    deployments: [],
    configMaps: [],
    pods: [pod("api-1", { app: "api" })],
  }, {
    name: "main",
    lifecycle: "persistent",
    discovery: { kind: "kubernetes-service", service: "api-v2" },
  });

  expect(resolved.service?.name).toBe("api-v2");
  expect(resolved.pods.map((item) => item.name)).toEqual(["api-1"]);
});
