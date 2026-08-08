import { describe, expect, spyOn, test } from "bun:test";
import {
  resolvePodTarget,
  type KubernetesCommandConfig,
} from "../src/command/kubernetes-target";
import { diagnosticPids, parseProcscan, pickPid } from "../src/collect/fact/process";
import type { Executor } from "../src/infra/k8s/executor";
import { KubernetesAccessContext } from "../src/infra/k8s/access";
import {
  podSelectionLabel,
  podSelectionTitle,
  shouldPreviewPodChoices,
  type PodChoice,
} from "../src/infra/k8s/pod-selection";
import { parsePodJson, pickContainer } from "../src/infra/k8s/target";

const POD_JSON = JSON.stringify({
  metadata: { name: "app-0", namespace: "ns1" },
  spec: {
    nodeName: "node-a",
    containers: [
      { name: "app", image: "repo/app:1.2", resources: { limits: { memory: "2Gi" }, requests: { memory: "1Gi" } } },
      { name: "sidecar", image: "repo/sc:1" },
    ],
  },
  status: {
    phase: "Running",
    startTime: "2026-07-01T00:00:00Z",
    containerStatuses: [
      { name: "app", restartCount: 2, ready: true, imageID: "docker-pullable://registry.example.com/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      { name: "sidecar", restartCount: 0, ready: true },
    ],
  },
});

const PROCSCAN_OUT = `   PID COMM              RSS_MB  THREADS    FDS
    11 python3             1843       12    210
    23 python3              412        8     88
     1 tini                   1        1     12

python workers (threads>4): 11 23
`;

test("Pod 候选较少且尚未展示时先打印列表", () => {
  const pods: PodChoice[] = Array.from({ length: 10 }, (_, index) => ({
    name: `app-${index}`,
    phase: "Running",
    ready: "1/1",
    restarts: 0,
    containers: [],
  }));
  expect(shouldPreviewPodChoices(pods, [])).toBe(true);
  expect(shouldPreviewPodChoices([...pods, pods[0]!], [])).toBe(false);
  expect(shouldPreviewPodChoices(pods, pods)).toBe(false);
});

test("配置来源选择明确说明用途和对象角色", () => {
  const selection = {
    role: "configuration-source" as const,
    purpose: "读取 Service 'kb-server' 的 vdb Store 'trace' 运行时配置",
  };
  expect(podSelectionLabel(selection, "Container")).toBe("配置来源 Container");
  expect(podSelectionTitle(selection)).toBe(
    "[collect] 读取 Service 'kb-server' 的 vdb Store 'trace' 运行时配置，请选择配置来源 Pod：",
  );
});

describe("parsePodJson", () => {
  test("extracts identity, containers, limits", () => {
    const pod = parsePodJson(POD_JSON);
    expect(pod.name).toBe("app-0");
    expect(pod.namespace).toBe("ns1");
    expect(pod.phase).toBe("Running");
    expect(pod.nodeName).toBe("node-a");
    expect(pod.containers).toHaveLength(2);
    expect(pod.containers[0]).toMatchObject({
      name: "app",
      image: "repo/app:1.2",
      imageId: "docker-pullable://registry.example.com/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      restartCount: 2,
      limits: { memory: "2Gi" },
    });
  });
});

describe("pickContainer", () => {
  const pod = parsePodJson(POD_JSON);

  test("flag wins", () => {
    const r = pickContainer(pod, "sidecar");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.name).toBe("sidecar");
  });

  test("unknown flag lists candidates", () => {
    const r = pickContainer(pod, "nope");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("app, sidecar");
  });

  test("multi-container without flag fails (不静默选择)", () => {
    const r = pickContainer(pod);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("-c");
  });

  test("single container auto-picked", () => {
    const single = parsePodJson(
      JSON.stringify({
        metadata: { name: "x", namespace: "ns" },
        spec: { containers: [{ name: "only", image: "i" }] },
        status: { phase: "Running" },
      }),
    );
    const r = pickContainer(single);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.name).toBe("only");
  });
});

test("单 Container 自动选择时打印目标", async () => {
  const podList = JSON.stringify({
    items: [{
      metadata: { name: "app-0" },
      spec: { containers: [{ name: "app", image: "repo/app:1" }] },
      status: { phase: "Running", containerStatuses: [{ ready: true, restartCount: 0 }] },
    }],
  });
  const executor: Executor = {
    run: async () => ({
      ok: true,
      exitCode: 0,
      stdout: podList,
      stderr: "",
      durationMs: 1,
      timedOut: false,
      command: [],
    }),
    exec: async () => { throw new Error("unexpected exec"); },
  };
  const config: KubernetesCommandConfig = {
    profileName: "test",
    kubernetes: {
      namespace: "default",
      namespaceSource: "profile:test",
      kubeconfigSource: "profile:test",
    },
  };
  const write = spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    await expect(resolvePodTarget({
      config,
      executor,
      pod: "app-0",
      selectContainer: true,
      interactive: false,
      selection: { role: "diagnostic-target", purpose: "采集测试数据" },
    })).resolves.toEqual({ pod: "app-0", container: "app" });
    expect(write).toHaveBeenCalledWith(
      "[target] container: app（pod/app-0 仅有一个 Container，自动选择）\n",
    );
  } finally {
    write.mockRestore();
  }
});

test("需要时允许把 Running Ephemeral Container 作为目标", async () => {
  const podList = JSON.stringify({
    items: [{
      metadata: { name: "app-0" },
      spec: {
        containers: [{ name: "app", image: "repo/app:1" }],
        ephemeralContainers: [{ name: "doctor-debug-x", image: "repo/app:1" }],
      },
      status: {
        phase: "Running",
        containerStatuses: [{ ready: true, restartCount: 0 }],
        ephemeralContainerStatuses: [{
          name: "doctor-debug-x",
          state: { running: { startedAt: "2026-07-27T00:00:00Z" } },
        }],
      },
    }],
  });
  const executor: Executor = {
    run: async () => ({
      ok: true,
      exitCode: 0,
      stdout: podList,
      stderr: "",
      durationMs: 1,
      timedOut: false,
      command: [],
    }),
    exec: async () => { throw new Error("unexpected exec"); },
  };
  const config: KubernetesCommandConfig = {
    profileName: "test",
    kubernetes: {
      namespace: "default",
      namespaceSource: "profile:test",
      kubeconfigSource: "profile:test",
    },
  };

  await expect(resolvePodTarget({
    config,
    executor,
    pod: "app-0",
    container: "doctor-debug-x",
    selectContainer: true,
    includeEphemeralContainers: true,
    interactive: false,
    selection: { role: "diagnostic-target", purpose: "运行测试探针" },
  })).resolves.toEqual({ pod: "app-0", container: "doctor-debug-x" });
});

test("preferred list pods 被拒绝时用精确 Pod get 完成目标选择", async () => {
  const calls: string[][] = [];
  const executor: Executor = {
    run: async (args) => {
      calls.push(args);
      const stdout = args[0] === "auth"
        ? args[2] === "list" ? "no\n" : "yes\n"
        : POD_JSON;
      return {
        ok: true,
        exitCode: 0,
        stdout,
        stderr: "",
        durationMs: 1,
        timedOut: false,
        command: args,
      };
    },
    exec: async () => { throw new Error("unexpected exec"); },
  };
  const config: KubernetesCommandConfig = {
    profileName: "test",
    kubernetes: {
      namespace: "ns1",
      namespaceSource: "flag",
      kubeconfigSource: "profile:test",
    },
  };

  await expect(resolvePodTarget({
    config,
    executor,
    pod: "app-0",
    container: "app",
    selectContainer: true,
    interactive: false,
    access: new KubernetesAccessContext(executor),
    selection: { role: "diagnostic-target", purpose: "运行测试探针" },
  })).resolves.toEqual({ pod: "app-0", container: "app" });
  expect(calls).toEqual([
    ["auth", "can-i", "list", "pods"],
    ["auth", "can-i", "get", "pods", "--resource-name=app-0"],
    ["get", "pod", "app-0", "-o", "json"],
  ]);
});

describe("parseProcscan / pickPid", () => {
  test("parses rows and workers", () => {
    const scan = parseProcscan(PROCSCAN_OUT);
    expect(scan.rows).toHaveLength(3);
    expect(scan.rows[0]).toMatchObject({ pid: 11, comm: "python3", rssMb: 1843, threads: 12, fds: 210 });
    expect(scan.workers).toEqual([11, 23]);
  });

  test("--pid flag wins", () => {
    const r = pickPid(parseProcscan(PROCSCAN_OUT), "23");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(23);
  });

  test("multi worker: picks max RSS with note", () => {
    const r = pickPid(parseProcscan(PROCSCAN_OUT));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBe(11);
      expect(r.note).toContain("--pid");
    }
  });

  test("Uvicorn topology keeps all business workers and excludes resource_tracker", () => {
    const scan = parseProcscan(`${PROCSCAN_OUT}uvicorn topology: master=8 workers=10 11\n`);
    expect(scan.uvicorn).toEqual({ masterPid: 8, workerPids: [10, 11] });
    expect(scan.workers).toEqual([10, 11]);
    const selected = diagnosticPids(scan);
    expect(selected).toEqual({ ok: true, value: [10, 11] });
  });

  test("no workers: falls back to python rows", () => {
    const out = `   PID COMM              RSS_MB  THREADS    FDS
     7 python3              300        2     10

python workers (threads>4): (none)
`;
    const r = pickPid(parseProcscan(out));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(7);
  });

  test("no python process: fails with hint", () => {
    const out = `   PID COMM              RSS_MB  THREADS    FDS
     1 java                 900       40    100
`;
    const r = pickPid(parseProcscan(out));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("--pid");
  });
});
