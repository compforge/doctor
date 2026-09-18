import { expect, test } from "bun:test";
import { DOCTOR_CLI_VERSION, formatDistributionVersion, formatDoctorVersion } from "../src/app/version";
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
  expect(formatDoctorVersion({ id: "test", version: "0.0.1" }, host())).toBe([
    `doctor ${DOCTOR_CLI_VERSION}`,
    "plugin test@0.0.1",
    "os linux 5.15.0-100",
    "arch x64",
    "glibc 2.31",
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

test("发行版版本与 Doctor Core、Plugin 版本独立", () => {
  expect(formatDoctorVersion({ id: "test", version: "1.0.0" }, undefined, {
    name: "samplectl", version: "2.3.4",
  })).toBe(`samplectl 2.3.4\ndoctor ${DOCTOR_CLI_VERSION}\nplugin test@1.0.0`);
});

test("默认发行版只显示一次 Doctor Core 版本", () => {
  expect(formatDistributionVersion()).toBe(`doctor ${DOCTOR_CLI_VERSION}`);
  expect(formatDoctorVersion(undefined)).toBe(`doctor ${DOCTOR_CLI_VERSION}\nplugin none`);
});

test("发行版名称和版本均可独立省略", () => {
  expect(formatDistributionVersion({ name: "samplectl" })).toBe(`samplectl ${DOCTOR_CLI_VERSION}`);
  expect(formatDistributionVersion({ version: "2.3.4" })).toBe("doctor 2.3.4");
  expect(formatDistributionVersion({ name: "samplectl", version: "2.3.4" })).toBe("samplectl 2.3.4");
});
