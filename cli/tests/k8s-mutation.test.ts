import { expect, test } from "bun:test";
import { infra } from "../src/infra";
import type { ExecResult, Executor, RunOptions } from "../src/infra/k8s/executor";
import { buildEphemeralContainerMutation } from "../src/infra/k8s/ephemeral-container";
import {
  executeK8sMutation,
  inspectK8sMutation,
} from "../src/infra/k8s/mutation";

const POD_JSON = JSON.stringify({
  apiVersion: "v1",
  kind: "Pod",
  metadata: { name: "app-0", namespace: "demo", resourceVersion: "42" },
  spec: { containers: [{ name: "app", image: "repo/app:1" }] },
});

function result(stdout = ""): ExecResult {
  return {
    ok: true,
    exitCode: 0,
    stdout,
    stderr: "",
    durationMs: 1,
    timedOut: false,
    command: ["kubectl"],
  };
}

function mutation(): ReturnType<typeof buildEphemeralContainerMutation> {
  return buildEphemeralContainerMutation({
    namespace: "demo",
    podName: "app-0",
    podJson: POD_JSON,
    targetContainer: "app",
    containerName: "doctor-austin-test",
    image: "repo/app:1",
    imagePullPolicy: "Never",
    command: ["python3", "-c", "import time; time.sleep(120)"],
    capabilities: ["SYS_PTRACE"],
    runAsUser: 0,
  });
}

test("K8s mutation 的 RBAC、server dry-run 与执行复用同一份资源描述", async () => {
  const calls: Array<{ args: string[]; options?: RunOptions }> = [];
  const exec: Executor = {
    run: async (args, options) => {
      calls.push({ args, options });
      return result(args[0] === "auth" ? "yes\n" : "{}");
    },
    exec: async () => result(),
  };
  const candidate = mutation();
  const preflight = await inspectK8sMutation(exec, candidate);
  await executeK8sMutation(exec, candidate);

  expect(preflight.fact).toEqual({
    authorization: "allowed",
    admission: "allowed",
    runnable: true,
    reason: undefined,
  });
  expect(calls.map(({ args }) => args)).toEqual([
    ["auth", "can-i", "update", "pods/ephemeralcontainers"],
    [
      "replace",
      "--raw",
      "/api/v1/namespaces/demo/pods/app-0/ephemeralcontainers?dryRun=All",
      "-f",
      "-",
    ],
    [
      "replace",
      "--raw",
      "/api/v1/namespaces/demo/pods/app-0/ephemeralcontainers",
      "-f",
      "-",
    ],
  ]);
  expect(calls[1]!.options?.stdin).toEqual(calls[2]!.options?.stdin);
  expect(JSON.parse(String(calls[1]!.options?.stdin)).spec.ephemeralContainers[0]).toMatchObject({
    name: "doctor-austin-test",
    imagePullPolicy: "Never",
    targetContainerName: "app",
    securityContext: {
      capabilities: { add: ["SYS_PTRACE"] },
      runAsUser: 0,
    },
  });
});

test("RBAC 拒绝时 mutation preflight 不再发送 dry-run", async () => {
  const calls: string[][] = [];
  const exec: Executor = {
    run: async (args) => {
      calls.push(args);
      return { ...result("no\n"), ok: false, exitCode: 1 };
    },
    exec: async () => result(),
  };
  const preflight = await inspectK8sMutation(exec, mutation());

  expect(preflight.fact).toEqual({
    authorization: "denied",
    admission: "not-checked",
    runnable: false,
    reason: "RBAC 不允许 update pods/ephemeralcontainers",
  });
  expect(calls).toHaveLength(1);
});

test("doctor debug container 固定进入目标 PID namespace 并申请 root SYS_PTRACE/NET_RAW", async () => {
  const calls: Array<{ args: string[]; options?: RunOptions }> = [];
  const exec: Executor = {
    run: async (args, options) => {
      calls.push({ args, options });
      return result("{}");
    },
    exec: async () => result(),
  };
  const preparation = infra.target.debugEngine.planPreparation(exec, {
    namespace: "demo",
    podName: "app-0",
    podJson: POD_JSON,
    targetContainer: "app",
    environmentName: "doctor-memory-test",
    image: "repo/doctor-debug:1",
    capabilities: ["SYS_PTRACE", "NET_RAW"],
  });
  await preparation.execute();
  const body = JSON.parse(String(calls[0]!.options?.stdin));
  expect(body.spec.ephemeralContainers[0]).toMatchObject({
    image: "repo/doctor-debug:1",
    imagePullPolicy: "IfNotPresent",
    targetContainerName: "app",
    securityContext: {
      capabilities: { add: ["SYS_PTRACE", "NET_RAW"] },
      runAsUser: 0,
    },
  });
  expect(body.spec.ephemeralContainers[0]).not.toHaveProperty("command");
});
