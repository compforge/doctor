import { expect, spyOn, test } from "bun:test";
import type { Executor, ExecResult } from "@compforge/harness-toolbox/kubernetes/executor";
import { resolvePodTarget, type KubernetesCommandConfig } from "../src/command/kubernetes-target";
import * as podSelection from "../src/infra/k8s/pod-selection";
import * as containerSelection from "../src/infra/k8s/container-selection";
import type { MemoryResizeTarget } from "../src/infra/target/memory-resize";
import { validateResizeOptions } from "../src/provision/resize/plan";
import { matchMemoryGrowth, matchResizeResource, memoryGrowthChoices, selectResizeMemory } from "../src/provision/resize/selection";
import { withInteractionOptions } from "../src/terminal/policy";
import * as selection from "../src/terminal/selection";
import * as output from "../src/terminal/output";

const GIB = 1024 ** 3;
const target: MemoryResizeTarget = {
  namespace: "default", pod: "worker-0", podUid: "pod-uid", container: "server", containerId: "container-id",
  restartCount: 0, node: "node-a", image: "example/worker:1", imagePullSecrets: [],
  declaredMemory: "4Gi", cgroupPath: "/pod/container", podCgroupPath: "/pod",
};
function result(stdout: string): ExecResult {
  return { ok: true, exitCode: 0, stdout, stderr: "", durationMs: 1, timedOut: false, command: [] };
}

test("percentage and numbered choices expand the observed limit by 50% or 100%", () => {
  const choices = memoryGrowthChoices(String(4 * GIB));
  expect(choices).toEqual([{ percent: 50, bytes: String(6 * GIB) }, { percent: 100, bytes: String(8 * GIB) }]);
  for (const answer of ["1", "50", "50%", "+50%"]) expect(matchMemoryGrowth(choices, answer)).toBe(String(6 * GIB));
  for (const answer of ["2", "100", "100%", "+100%"]) expect(matchMemoryGrowth(choices, answer)).toBe(String(8 * GIB));
  expect(matchMemoryGrowth(choices, "3")).toBeUndefined();
  expect(memoryGrowthChoices(String(3 * 1024 ** 2))[0]!.bytes).toBe(String(5 * 1024 ** 2));
  expect(() => memoryGrowthChoices("9223372036854771712")).toThrow("有限内存上限");
});

test("CPU remains unavailable and --yes cannot silently select a growth candidate", () => {
  expect(matchResizeResource("1")).toBe("mem");
  expect(matchResizeResource("mem")).toBe("mem");
  expect(matchResizeResource("cpu")).toBeUndefined();
  expect(matchResizeResource("2")).toBeUndefined();
  withInteractionOptions({ yes: true }, () => {
    expect(() => validateResizeOptions({ interactive: true })).toThrow("--memory");
    expect(() => validateResizeOptions({ pod: "worker-0", memory: "8Gi" })).not.toThrow();
  });
});

async function choose(options: { answers?: Array<string | undefined>; memory?: string; limit?: string; raw?: string } = {}) {
  const events: string[] = [];
  const answers = [...(options.answers ?? ["mem", "50% "])];
  let printed = "";
  const executor: Executor = {
    run: async () => { throw new Error("selection must not create or modify Kubernetes resources"); },
    exec: async () => {
      events.push("read-memory");
      return result(options.raw ?? `version=1\ncurrent_bytes=${3 * GIB}\nlimit_bytes=${options.limit ?? 8 * GIB}\n`);
    },
  };
  const print = spyOn(output, "writeOutput").mockImplementation(text => { printed += text; return true; });
  const prompt = spyOn(selection, "promptListedChoice").mockImplementation(async request => {
    events.push(request.question.startsWith("资源类型") ? "resource" : "growth");
    const answer = answers.shift();
    return answer === undefined ? undefined : request.match(answer);
  });
  try {
    const selected = await selectResizeMemory(executor, target, { interactive: true, memory: options.memory });
    return { selected, events, printed, prompts: prompt.mock.calls.length };
  } finally { prompt.mockRestore(); print.mockRestore(); }
}

test("selection asks for a resource before reading memory, then offers growth from the running limit", async () => {
  const outcome = await choose();
  expect(outcome.events).toEqual(["resource", "read-memory", "growth"]);
  // spec remains 4Gi but the previous temporary limit is 8Gi: +50% must mean 12Gi.
  expect(outcome.selected).toEqual({ requestedBytes: String(12 * GIB), expectedLimitBytes: String(8 * GIB) });
  expect(outcome.printed).toContain("8.0 GiB");
  expect(outcome.printed).toContain("12.0 GiB");
  expect(outcome.printed).toContain("16.0 GiB");
});

test("cancelling either resource or growth selection does not enter Provision", async () => {
  const resource = await choose({ answers: [undefined] });
  expect(resource.selected).toBeUndefined();
  expect(resource.events).toEqual(["resource"]);
  const growth = await choose({ answers: ["mem", undefined] });
  expect(growth.selected).toBeUndefined();
  expect(growth.events).toEqual(["resource", "read-memory", "growth"]);
});

test("explicit --memory retains automation without prompting, and missing runtime facts fail", async () => {
  const explicit = await choose({ memory: "16Gi" });
  expect(explicit.prompts).toBe(0);
  expect(explicit.selected).toEqual({ requestedBytes: String(16 * GIB), expectedLimitBytes: String(8 * GIB) });
  await expect(choose({ raw: "version=1\ncurrent_bytes=1\n" })).rejects.toThrow("无法确认");
});


test("noninteractive resize requires Pod and memory before discovery", () => {
  expect(() => validateResizeOptions({ interactive: false })).toThrow("--pod");
  expect(() => validateResizeOptions({ interactive: false, memory: "8Gi" })).toThrow("--pod");
  expect(() => validateResizeOptions({ interactive: false, pod: "worker-0" })).toThrow("--memory");
  expect(() => validateResizeOptions({ interactive: false, pod: "worker-0", memory: "8Gi" })).not.toThrow();
  expect(() => validateResizeOptions({ interactive: true, pod: "worker-0" })).not.toThrow();
  expect(() => validateResizeOptions({ interactive: true, memory: "8Gi" })).not.toThrow();
});

const config: KubernetesCommandConfig = {
  profileName: "test", kubernetes: { namespace: "default", namespaceSource: "profile:test", kubeconfigSource: "profile:test" },
};
function targetInput(names: string[], interactive: boolean, pod?: string, container?: string) {
  const executor: Executor = {
    run: async () => result(JSON.stringify({ items: [{ metadata: { name: target.pod },
      spec: { containers: names.map(name => ({ name, image: target.image })) }, status: { phase: "Running" } }] })),
    exec: async () => { throw new Error("target selection must not execute commands in a container"); },
  };
  return { config, executor, interactive, pod, container, selectContainer: true,
    selection: { candidateRole: "目标" as const, purpose: "手动调整实例内存上限" } };
}

test("automation infers a sole container but requires an explicit name for multiple containers", async () => {
  await expect(resolvePodTarget(targetInput(["server"], false, target.pod)))
    .resolves.toEqual({ pod: target.pod, container: "server" });
  await expect(resolvePodTarget(targetInput(["server", "sidecar"], false, target.pod)))
    .rejects.toThrow("--container");
  await expect(resolvePodTarget(targetInput(["server", "sidecar"], false, target.pod, "server")))
    .resolves.toEqual({ pod: target.pod, container: "server" });
  await expect(resolvePodTarget(targetInput(["server", "sidecar"], false, target.pod, "missing")))
    .rejects.toThrow("不存在");
});

test("interactive target selection fills only missing Pod and container parameters", async () => {
  const events: string[] = [];
  const pod = spyOn(podSelection, "promptPod").mockImplementation(async () => { events.push("pod"); return target.pod; });
  const container = spyOn(containerSelection, "promptContainer").mockImplementation(async () => { events.push("container"); return "server"; });
  try {
    await expect(resolvePodTarget(targetInput(["server", "sidecar"], true)))
      .resolves.toEqual({ pod: target.pod, container: "server" });
    expect(events).toEqual(["pod", "container"]);
    events.length = 0;
    await resolvePodTarget(targetInput(["server", "sidecar"], true, target.pod));
    expect(events).toEqual(["container"]);
    events.length = 0;
    await resolvePodTarget(targetInput(["server", "sidecar"], true, target.pod, "server"));
    expect(events).toEqual([]);
    await resolvePodTarget(targetInput(["server"], true));
    expect(events).toEqual(["pod"]);
  } finally { container.mockRestore(); pod.mockRestore(); }
});
