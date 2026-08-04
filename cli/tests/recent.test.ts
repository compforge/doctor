import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RecentSelections,
  resolveKubernetesRecentScope,
} from "../src/infra/recent";

function recentPath(): string {
  return join(mkdtempSync(join(tmpdir(), "doctor-recent-")), "recent.json");
}

describe("recent.json", () => {
  test("按 kubeconfig current-context 隔离 Kubernetes 历史", () => {
    const directory = mkdtempSync(join(tmpdir(), "doctor-kubeconfig-"));
    const kubeconfig = join(directory, "config");
    writeFileSync(kubeconfig, "current-context: cluster-dev\n", "utf8");

    expect(resolveKubernetesRecentScope({ kubeconfig })).toEqual({
      kubeconfig,
      context: "cluster-dev",
    });
    expect(resolveKubernetesRecentScope({
      kubeconfig,
      context: "cluster-prod",
    })).toEqual({
      kubeconfig,
      context: "cluster-prod",
    });
  });

  test("实时状态优先，同状态候选按近期使用排序", () => {
    const path = recentPath();
    let now = new Date("2026-07-28T01:00:00.000Z");
    const recent = new RecentSelections(path, () => now);
    const scope = { kubeconfig: "/tmp/kubeconfig", context: "dev" };

    recent.recordKubernetesTarget(scope, {
      namespace: "ns-b",
      service: "service-b",
      pod: "pod-b",
      container: "app",
    });
    now = new Date("2026-07-28T02:00:00.000Z");
    recent.recordKubernetesTarget(scope, {
      namespace: "ns-z",
      pod: "pod-z",
    });

    expect(recent.rankNamespaces(scope, [
      { name: "ns-a", phase: "Active" },
      { name: "ns-b", phase: "Active" },
      { name: "ns-z", phase: "Terminating" },
    ]).map((choice) => choice.name)).toEqual(["ns-b", "ns-a", "ns-z"]);

    expect(recent.rankPods(scope, "ns-b", [
      { name: "pod-a", phase: "Running" },
      { name: "pod-b", phase: "Running" },
      { name: "pod-z", phase: "Failed" },
    ]).map((choice) => choice.name)).toEqual(["pod-b", "pod-a", "pod-z"]);
    expect(recent.recentPods(scope, "ns-b", [
      { name: "pod-a", phase: "Running" },
      { name: "pod-b", phase: "Running" },
    ]).map((choice) => choice.name)).toEqual(["pod-b"]);
    expect(recent.rankContainers(scope, "ns-b", "pod-b", [
      { name: "sidecar" },
      { name: "app" },
    ]).map((choice) => choice.name)).toEqual(["app", "sidecar"]);

    expect(recent.rankServices(scope, "ns-b", [
      { name: "service-a" },
      { name: "service-b" },
    ]).map((choice) => choice.name)).toEqual(["service-b", "service-a"]);
  });

  test("同一完整 target 累加次数并以 0600 原子落盘", () => {
    const path = recentPath();
    const recent = new RecentSelections(
      path,
      () => new Date("2026-07-28T03:00:00.000Z"),
    );
    const scope = { kubeconfig: "/tmp/kubeconfig", context: "dev" };
    const target = {
      namespace: "dev",
      pod: "api-0",
      container: "api",
    };

    recent.recordKubernetesTarget(scope, target);
    recent.recordKubernetesTarget(scope, target);

    const document = JSON.parse(readFileSync(path, "utf8"));
    expect(document.version).toBe(1);
    expect(document.kubernetes.targets).toEqual([{
      ...scope,
      ...target,
      last_used_at: "2026-07-28T03:00:00.000Z",
      use_count: 2,
    }]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("image registry 和 namespace 使用独立历史", () => {
    const path = recentPath();
    const recent = new RecentSelections(
      path,
      () => new Date("2026-07-28T04:00:00.000Z"),
    );
    const scope = { kubeconfig: "/tmp/kubeconfig", context: "dev" };

    recent.recordImageTarget(scope, {
      registry: "registry-b.example.com",
      namespace: "team-b",
    });

    expect(recent.rankImageRegistries(scope, [
      "registry-a.example.com",
      "registry-b.example.com",
    ])).toEqual(["registry-b.example.com", "registry-a.example.com"]);
    expect(recent.rankImageNamespaces(scope, "registry-b.example.com", [
      "team-a",
      "team-b",
    ])).toEqual(["team-b", "team-a"]);
  });
});
