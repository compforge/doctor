// profile 的 server 字段不再隐式选择远端；远端兼容所需的上传配置仍做校验。
// - collect 可通过 --profile 取本地 profile 的 kubeconfig
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateProfile } from "../src/app/config/config";
import {
  resolveCollectDebugImage,
  resolveCollectKubeconfig,
  resolveCollectNamespace,
} from "../src/infra/k8s/context";

describe("validateProfile", () => {
  test("llm 可空", () => {
    const r = validateProfile({ readonly: true });
    expect(r.errors).toEqual([]);
  });

  test("配了 server 时仍校验远端兼容所需的 llm", () => {
    const r = validateProfile({ server: "h:1", readonly: true });
    expect(r.errors.some((e) => e.includes("llm"))).toBe(true);
  });
});

describe("resolveCollectKubeconfig", () => {
  function writeConfig(kubeconfigPath?: string): string {
    const dir = mkdtempSync(join(tmpdir(), "doctor-local-"));
    const kube = kubeconfigPath ? `\n    kube:\n      kubeconfig_path: ${kubeconfigPath}` : "";
    const configPath = join(dir, "config.yaml");
    writeFileSync(configPath, `profiles:\n  local:\n    readonly: true${kube}\n`, "utf-8");
    return configPath;
  }

  test("--kubeconfig 最优先，且不读 config", () => {
    expect(resolveCollectKubeconfig({ kubeconfig: "/k/c", profile: "local", config: "/does/not/exist" })).toEqual({
      kubeconfig: "/k/c",
      source: "flag",
    });
  });

  test("default profile 未配 kube 时回落 kubectl 默认查找", () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-local-"));
    const configPath = join(dir, "config.yaml");
    writeFileSync(configPath, "profiles:\n  remote:\n    server: h:1\n    readonly: true\n", "utf-8");
    expect(resolveCollectKubeconfig({ config: configPath })).toEqual({ source: "kubectl-default" });
  });

  test("未给 --profile 时 best-effort 用 default profile 的 kubeconfig（文件需存在）", () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-kube-"));
    const kubePath = join(dir, "kubeconfig");
    writeFileSync(kubePath, "apiVersion: v1\n", "utf-8");
    const configPath = writeConfig(kubePath);
    expect(resolveCollectKubeconfig({ config: configPath })).toEqual({
      kubeconfig: kubePath,
      source: "profile:local",
    });
  });

  test("--profile 取 profile 的 kubeconfig_path", () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-kube-"));
    const kubePath = join(dir, "kubeconfig");
    writeFileSync(kubePath, "apiVersion: v1\n", "utf-8");
    const configPath = writeConfig(kubePath);
    expect(resolveCollectKubeconfig({ profile: "local", config: configPath })).toEqual({
      kubeconfig: kubePath,
      source: "profile:local",
    });
  });

  test("profile 未配 kube 时报错", () => {
    const configPath = writeConfig();
    expect(() => resolveCollectKubeconfig({ profile: "local", config: configPath })).toThrow(
      "kube.kubeconfig_path",
    );
  });
});

describe("resolveCollectNamespace", () => {
  test("--namespace 优先于 profile", () => {
    expect(resolveCollectNamespace({
      namespace: "command-ns",
      profile: "missing",
      config: "/does/not/exist",
    })).toEqual({ namespace: "command-ns", source: "flag" });
  });

  test("命令未提供时使用当前 profile 的 namespace", () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-local-"));
    const configPath = join(dir, "config.yaml");
    writeFileSync(configPath, "default_profile: dev\nprofiles:\n  dev:\n    readonly: true\n    namespace: dev-system\n", "utf-8");
    expect(resolveCollectNamespace({ config: configPath })).toEqual({
      namespace: "dev-system",
      source: "profile:dev",
    });
  });

  test("命令和 profile 都未提供时使用 default", () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-local-"));
    const configPath = join(dir, "config.yaml");
    writeFileSync(configPath, "profiles:\n  local:\n    readonly: true\n", "utf-8");
    expect(resolveCollectNamespace({ config: configPath })).toEqual({
      namespace: "default",
      source: "default",
    });
  });
});

describe("resolveCollectDebugImage", () => {
  test("--debug-image 优先于 profile", () => {
    expect(resolveCollectDebugImage({
      debugImage: "registry/flag:1",
      profile: "missing",
      config: "/does/not/exist",
    })).toEqual({ image: "registry/flag:1", source: "flag" });
  });

  test("从当前 profile 读取 kube.debug_image", () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-debug-image-"));
    const configPath = join(dir, "config.yaml");
    writeFileSync(
      configPath,
      "profiles:\n  local:\n    readonly: true\n    kube:\n      debug_image: registry/profile:1\n",
      "utf-8",
    );
    expect(resolveCollectDebugImage({ config: configPath })).toEqual({
      image: "registry/profile:1",
      source: "profile:local",
    });
  });

  test("未配置调试镜像时保持 unconfigured，不猜公共镜像", () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-debug-image-"));
    const configPath = join(dir, "config.yaml");
    writeFileSync(configPath, "profiles:\n  local:\n    readonly: true\n", "utf-8");
    expect(resolveCollectDebugImage({ config: configPath })).toEqual({ source: "unconfigured" });
  });
});
