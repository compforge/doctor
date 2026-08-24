import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const selector = fileURLToPath(new URL("../scripts/select-linux-x64-artifact.sh", import.meta.url));
const makefile = readFileSync(new URL("../Makefile", import.meta.url), "utf8");

function select(kernel: string, glibc: string, arch = "x86_64") {
  return spawnSync("sh", [selector, "1.2.3"], {
    encoding: "utf8",
    env: {
      ...process.env,
      DOCTOR_KERNEL_VERSION: kernel,
      DOCTOR_GLIBC_VERSION: glibc,
      DOCTOR_MACHINE_ARCH: arch,
    },
  });
}

describe("Linux x64 runtime artifact selection", () => {
  test("modern kernel and glibc select Bun baseline", () => {
    const result = select("6.8.0", "glibc 2.39");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("doctor-1.2.3-debian-x64-kernel-5.6-glibc-2.25");
  });

  test("RHEL 7 selects glibc 2.17 SEA", () => {
    const result = select("3.10.0-862.el7.x86_64", "glibc 2.17");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("doctor-1.2.3-debian-x64-kernel-3.10-glibc-2.17");
  });

  test("new kernel with old glibc still selects SEA", () => {
    const result = select("5.15.0", "glibc 2.17");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("doctor-1.2.3-debian-x64-kernel-3.10-glibc-2.17");
  });

  test("does not guess for musl or unsupported architecture", () => {
    expect(select("6.8.0", "musl 1.2.5").status).toBe(2);
    expect(select("6.8.0", "glibc 2.39", "aarch64").status).toBe(2);
  });

  test("Linux build artifacts include distribution, kernel, and glibc", () => {
    expect(makefile).toContain("-debian-x64-kernel-5.6-glibc-2.25");
    expect(makefile).toContain("-debian-x64-kernel-3.10-glibc-2.17");
    expect(makefile).toContain("-debian-arm64-kernel-5.6-glibc-2.25");
    expect(makefile).toContain("-kylin-x86-64-kernel-4.19-glibc-2.28");
    expect(makefile).toContain("-kylin-arm64-kernel-4.19-glibc-2.28");
  });
});
