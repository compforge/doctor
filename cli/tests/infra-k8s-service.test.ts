import { expect, test } from "bun:test";
import type { Executor } from "../src/infra/k8s/executor";
import {
  findPod,
  parsePods,
} from "../src/infra/k8s/pod";
import { PortForwardScope, type PortForwardTarget } from "../src/infra/k8s/port-forward";
import { ServicePortForwarder } from "../src/infra/k8s/service-port-forward";
import {
  findService,
  findServicesForPod,
  parseServices,
  serviceIdentity,
} from "../src/infra/k8s/service";

function serviceList(targetPort: string | number = 6379): string {
  return JSON.stringify({
    items: [
      {
        metadata: { namespace: "dev", name: "redis", labels: { app: "redis" } },
        spec: {
          clusterIP: "10.0.0.8",
          selector: { app: "redis" },
          ports: [{ name: "redis", port: 6379, targetPort }],
          containers: [{
            name: "redis",
            image: "registry.example/redis:7.2",
            resources: {
              requests: { cpu: "250m", memory: "256Mi" },
              limits: { cpu: "1", memory: "1Gi" },
            },
          }],
        },
        status: {
          podIP: "10.1.0.8",
          containerStatuses: [{
            name: "redis",
            imageID: "registry.example/redis@sha256:1234",
            restartCount: 2,
            lastState: { terminated: { containerID: "containerd://previous" } },
          }],
        },
      },
    ],
  });
}

const raw = serviceList();

const podList = JSON.stringify({
  items: [
    {
      metadata: { namespace: "dev", name: "redis-1", labels: { app: "redis" } },
      status: { phase: "Running", podIP: "10.1.0.9" },
    },
    {
      metadata: { namespace: "dev", name: "redis-0", labels: { app: "redis" } },
      status: { phase: "Running", podIP: "10.1.0.8" },
    },
    {
      metadata: { namespace: "dev", name: "redis-old", labels: { app: "redis" } },
      status: { phase: "Succeeded", podIP: "10.1.0.7" },
    },
  ],
});

test("K8s Service 解析支持短名、完整 DNS 和 ClusterIP", () => {
  const services = parseServices(raw, "dev");
  expect(serviceIdentity("redis.dev.svc.cluster.local", "other")).toEqual({
    name: "redis",
    namespace: "dev",
  });
  expect(findService(services, { host: "redis", port: 6379 }, "dev")?.name).toBe("redis");
  expect(findService(services, { host: "redis.dev.svc", port: 6379 }, "other")?.name).toBe("redis");
  expect(findService(services, { host: "10.0.0.8", port: 6379 }, "dev")?.name).toBe("redis");
  expect(findService(services, { host: "redis", port: 6380 }, "dev")).toBeUndefined();
});

test("K8s Pod endpoint 可按 Pod 名、FQDN 和 PodIP 解析", () => {
  const pods = parsePods(raw, "dev");
  expect(findPod(pods, { host: "redis", port: 6379 }, "dev")?.name).toBe("redis");
  expect(findPod(pods, { host: "redis.redis-headless.dev.svc.cluster.local", port: 6379 }, "dev")?.name)
    .toBe("redis");
  expect(findPod(pods, { host: "10.1.0.8", port: 6379 }, "dev")?.name).toBe("redis");
  expect(findServicesForPod(parseServices(raw, "dev"), pods[0]!).map((service) => service.name))
    .toEqual(["redis"]);
  expect(pods[0]!.containers).toEqual([{
    name: "redis",
    image: "registry.example/redis:7.2",
    imageId: "registry.example/redis@sha256:1234",
    requests: { cpu: "250m", memory: "256Mi" },
    limits: { cpu: "1", memory: "1Gi" },
    restartCount: 2,
    hasPreviousTerminated: true,
  }]);
});

test("ServicePortForwarder 解析 Service、缓存 forward 并保留逻辑 servername", async () => {
  const executor: Executor = {
    run: async (args) => ({
      ok: true,
      exitCode: 0,
      stdout: args[1] === "services" ? raw : JSON.stringify({ items: [] }),
      stderr: "",
      durationMs: 1,
      timedOut: false,
      command: ["kubectl", ...args],
    }),
    exec: async () => { throw new Error("unexpected exec"); },
  };
  let starts = 0;
  const forwarder = await ServicePortForwarder.create(executor, { namespace: "dev" }, async (opts) => {
    starts += 1;
    return {
      ok: true,
      value: {
        target: opts.target!,
        localPort: 16_379,
        command: ["kubectl", "port-forward", "svc/redis", "0:6379"],
        stop: () => undefined,
      },
    };
  });
  try {
    expect(await forwarder.forward({ host: "redis.dev.svc", port: 6379 })).toEqual({
      host: "127.0.0.1",
      port: 16_379,
      servername: "redis.dev.svc",
    });
    expect(await forwarder.forward({ host: "redis.dev.svc", port: 6379 })).toEqual({
      host: "127.0.0.1",
      port: 16_379,
      servername: "redis.dev.svc",
    });
    expect(starts).toBe(1);
  } finally {
    forwarder.stop();
  }
});

test("ServicePortForwarder 将 Service 展开为全部 Running Pod target", async () => {
  const executor: Executor = {
    run: async (args) => ({
      ok: true,
      exitCode: 0,
      stdout: args[1] === "services" ? raw : podList,
      stderr: "",
      durationMs: 1,
      timedOut: false,
      command: ["kubectl", ...args],
    }),
    exec: async () => { throw new Error("unexpected exec"); },
  };
  let nextPort = 16_379;
  const targets: PortForwardTarget[] = [];
  const forwarder = await ServicePortForwarder.create(executor, { namespace: "dev" }, async (opts) => ({
    ok: true,
    value: {
      target: opts.target!,
      localPort: nextPort++,
      command: ["kubectl", "port-forward"],
      stop: () => undefined,
    },
  }));
  try {
    const endpoints = await forwarder.forwardServiceTargets({ host: "redis", port: 6379 });
    targets.push(...forwarder.activeForwards.map((forward) => forward.target));
    expect(endpoints).toEqual([
      { host: "127.0.0.1", port: 16_379, servername: "redis-0", pod: "redis-0" },
      { host: "127.0.0.1", port: 16_380, servername: "redis-1", pod: "redis-1" },
    ]);
    expect(targets).toEqual([
      { kind: "pod", name: "redis-0" },
      { kind: "pod", name: "redis-1" },
    ]);
  } finally {
    forwarder.stop();
  }
});

test("ServicePortForwarder 使用数值 targetPort，并保留成功的 Pod target", async () => {
  const executor: Executor = {
    run: async (args) => ({
      ok: true,
      exitCode: 0,
      stdout: args[1] === "services" ? serviceList(6380) : podList,
      stderr: "",
      durationMs: 1,
      timedOut: false,
      command: ["kubectl", ...args],
    }),
    exec: async () => { throw new Error("unexpected exec"); },
  };
  const remotePorts: number[] = [];
  const forwarder = await ServicePortForwarder.create(executor, { namespace: "dev" }, async (opts) => {
    remotePorts.push(opts.remotePort);
    if (opts.target?.name === "redis-1") return { ok: false, reason: "unreachable" };
    return {
      ok: true,
      value: {
        target: opts.target!,
        localPort: 16_380,
        command: ["kubectl", "port-forward"],
        stop: () => undefined,
      },
    };
  });
  try {
    expect(await forwarder.forwardServiceTargets({ host: "redis", port: 6379 })).toEqual([
      { host: "127.0.0.1", port: 16_380, servername: "redis-0", pod: "redis-0" },
    ]);
    expect(remotePorts).toEqual([6380, 6380]);
  } finally {
    forwarder.stop();
  }
});

test("ServicePortForwarder 对命名 targetPort 回退为 Service 转发", async () => {
  const executor: Executor = {
    run: async (args) => ({
      ok: true,
      exitCode: 0,
      stdout: args[1] === "services" ? serviceList("redis") : podList,
      stderr: "",
      durationMs: 1,
      timedOut: false,
      command: ["kubectl", ...args],
    }),
    exec: async () => { throw new Error("unexpected exec"); },
  };
  const targets: PortForwardTarget[] = [];
  const forwarder = await ServicePortForwarder.create(executor, { namespace: "dev" }, async (opts) => {
    targets.push(opts.target!);
    return {
      ok: true,
      value: {
        target: opts.target!,
        localPort: 16_379,
        command: ["kubectl", "port-forward"],
        stop: () => undefined,
      },
    };
  });
  try {
    expect(await forwarder.forwardServiceTargets({ host: "redis", port: 6379 })).toEqual([
      { host: "127.0.0.1", port: 16_379, servername: "redis" },
    ]);
    expect(targets).toEqual([{ kind: "service", name: "redis" }]);
  } finally {
    forwarder.stop();
  }
});

test("PortForwardScope 逆序回收多个 Service/Pod forward", async () => {
  const stopped: PortForwardTarget[] = [];
  let nextPort = 10_000;
  const scope = new PortForwardScope(async (opts) => ({
    ok: true,
    value: {
      target: opts.target!,
      localPort: nextPort++,
      command: ["kubectl", "port-forward"],
      stop: () => stopped.push(opts.target!),
    },
  }));
  await scope.start({ namespace: "dev", target: { kind: "service", name: "redis" }, remotePort: 6379 });
  await scope.start({ namespace: "dev", target: { kind: "pod", name: "redis-0" }, remotePort: 6379 });
  expect(scope.active.map((forward) => forward.localPort)).toEqual([10_000, 10_001]);
  scope.stop();
  expect(stopped).toEqual([
    { kind: "pod", name: "redis-0" },
    { kind: "service", name: "redis" },
  ]);
  expect(scope.active).toHaveLength(0);
});
