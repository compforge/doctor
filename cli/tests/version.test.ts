import { expect, test } from "bun:test";
import { formatDoctorVersion } from "../src/app/version";
import type { DoctorHostInfo } from "../src/infra/host";

function host(overrides: Partial<DoctorHostInfo> = {}): DoctorHostInfo {
  return {
    platform: "linux",
    architecture: "x64",
    kernelRelease: "5.15.0-100",
    glibcVersion: "2.31",
    cpu: { logicalCount: 4 },
    totalMemoryBytes: 8 * 1024 * 1024 * 1024,
    runtime: { name: "bun", version: "1.3.11" },
    ...overrides,
  };
}

test("doctor version 输出 Doctor Host 的 OS、arch 和 glibc", () => {
  expect(formatDoctorVersion({ id: "test", version: "0.0.1" }, host(), "v1.32.3")).toBe([
    "doctor 0.1.56",
    "plugin test@0.0.1",
    "os linux 5.15.0-100",
    "arch x64",
    "glibc 2.31",
    "kubernetes v1.32.3",
  ].join("\n"));
});

test("非 Linux Doctor Host 明确标记 glibc 不适用", () => {
  expect(formatDoctorVersion(undefined, host({
    platform: "darwin",
    architecture: "arm64",
    kernelRelease: "25.6.0",
    glibcVersion: undefined,
  }))).toContain("os darwin 25.6.0\narch arm64\nglibc n/a");
});

test("Kubernetes Server 版本不可用时省略该行", () => {
  expect(formatDoctorVersion(undefined, host())).not.toContain("kubernetes");
});
