import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildInstallPlan,
  packageBundleMissingMessage,
  parseInstallProgram,
  renderInstallCompatibilityMarkdown,
  writeInstallCompatibilityReport,
  type InstallCompatibilityReport,
} from "../src/provision/install";
import {
  bundleMatches,
  inspectPackageBundle,
  inspectPackageBundles,
  materializePackageBundle,
  onlineInstallCommands,
  selectPackageBundle,
} from "../src/infra/target/package-install";
import { kubernetesPackageInstaller } from "../src/infra/target/package-install/k8s";
import type {
  ExecResult,
  ExecTarget,
  Executor,
  RunOptions,
} from "../src/infra/k8s/executor";
import type { PackageTargetFact } from "../src/infra/target/package-install";

function result(stdout = "", ok = true): ExecResult {
  return {
    ok,
    exitCode: ok ? 0 : 1,
    stdout,
    stderr: ok ? "" : "failed",
    durationMs: 1,
    timedOut: false,
    command: ["kubectl"],
  };
}

const aptTarget: PackageTargetFact = {
  manager: { kind: "apt-get", path: "/usr/bin/apt-get" },
  osId: "debian",
  osVersionId: "12",
  architecture: "amd64",
  kernelVersion: "5.15.0-100-generic",
  pythonAvailable: true,
  tarAvailable: true,
};

function createFixtureBundle(input: {
  root: string;
  name: string;
  version: string;
  minInclusive?: string;
  maxExclusive?: string;
}): string {
  const fixtureRoot = join(input.root, input.name);
  const bundleRoot = join(fixtureRoot, "doctor-packages");
  const repo = join(bundleRoot, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(bundleRoot, "manifest.json"), JSON.stringify({
    schema: "doctor-packages/v1",
    bundleVersion: "0.0.3",
    packageManager: "apt-get",
    osId: "debian",
    osVersionId: "12",
    architecture: "amd64",
    packages: ["gdb"],
    packageVersions: { gdb: input.version },
    compatibility: {
      kernel: {
        minInclusive: input.minInclusive,
        maxExclusive: input.maxExclusive,
      },
    },
  }));
  writeFileSync(join(repo, "Packages"), "Package: gdb\n");
  writeFileSync(join(repo, `gdb_${input.version}_amd64.deb`), "fixture");
  const tarPath = join(input.root, `${input.name}.tar`);
  const archived = Bun.spawnSync({
    cmd: ["tar", "--format", "ustar", "-cf", tarPath, "doctor-packages"],
    cwd: fixtureRoot,
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(archived.exitCode).toBe(0);
  return tarPath;
}

test("doctor install 首版仅接受 GDB", () => {
  expect(parseInstallProgram("gdb")).toBe("gdb");
  expect(parseInstallProgram("GDB")).toBe("gdb");
  expect(() => parseInstallProgram("strace")).toThrow("目前仅支持安装 gdb");
});

test("doctor install 缺少 bundle 时说明它不是 image tar 或现场生成文件", () => {
  const message = packageBundleMissingMessage(aptTarget);
  expect(message).toContain("离线软件仓");
  expect(message).toContain("它不是 image tar");
  expect(message).toContain("不是在客户 Pod 内现场生成");
  expect(message).toContain("make build-gdb-package-bundles");
  expect(message).toContain("kernel=5.15.0-100-generic");
});

test("显式 --tar 在非 APT 目标上形成 unsupported 计划", () => {
  const plan = buildInstallPlan({
    target: {
      ...aptTarget,
      manager: { kind: "apk", path: "/sbin/apk" },
    },
    packages: ["gdb"],
    explicitBundle: true,
  });
  expect(plan).toMatchObject({
    kind: "unsupported",
    reason: expect.stringContaining("不能执行已通过 --tar 指定的离线安装计划"),
  });
});

test("APT 离线包按 schema、平台和 GDB 清单匹配", () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-package-bundle-"));
  const bundleRoot = join(root, "doctor-packages");
  const repo = join(bundleRoot, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(bundleRoot, "manifest.json"), JSON.stringify({
    schema: "doctor-packages/v1",
    bundleVersion: "0.0.1",
    packageManager: "apt-get",
    osId: "debian",
    osVersionId: "12",
    architecture: "amd64",
    packages: ["gdb"],
    packageVersions: { gdb: "13.1-3" },
    compatibility: { kernel: { minInclusive: "5.10", maxExclusive: "6.0" } },
  }));
  writeFileSync(join(repo, "Packages"), "Package: gdb\n");
  writeFileSync(join(repo, "gdb_1_amd64.deb"), "fixture");
  const tarPath = join(root, "doctor-packages-debian12-amd64.tar");
  const archived = Bun.spawnSync({
    cmd: ["tar", "--format", "ustar", "-cf", tarPath, "doctor-packages"],
    cwd: root,
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(archived.exitCode).toBe(0);
  const bundle = inspectPackageBundle(tarPath);
  expect(bundle.manifest.bundleVersion).toBe("0.0.1");
  expect(bundle.manifest.packages).toEqual(["gdb"]);
  expect(bundle.manifest.packageVersions).toEqual({ gdb: "13.1-3" });
  expect(bundleMatches(bundle, aptTarget, ["gdb"])).toBe(true);
  expect(bundleMatches(bundle, { ...aptTarget, kernelVersion: "6.1.0" }, ["gdb"])).toBe(false);
  expect(bundleMatches(bundle, aptTarget, ["strace"])).toBe(false);
});

test("多个 GDB bundle 自动选择 kernel 范围匹配且版本更高的候选", () => {
  const bundle = (
    path: string,
    version: string,
    minInclusive?: string,
    maxExclusive?: string,
  ) => ({
    path,
    manifest: {
      schema: "doctor-packages/v1" as const,
      bundleVersion: "0.0.2",
      packageManager: "apt-get" as const,
      osId: "debian",
      osVersionId: "12",
      architecture: "amd64",
      packages: ["gdb"],
      packageVersions: { gdb: version },
      compatibility: minInclusive || maxExclusive
        ? { kernel: { minInclusive, maxExclusive } }
        : undefined,
    },
  });
  const selected = selectPackageBundle([
    bundle("/generic-gdb-16.tar", "16.3"),
    bundle("/kernel-5-gdb-12.tar", "12.1", "5.0", "6.0"),
    bundle("/kernel-5-gdb-13.tar", "13.2", "5.0", "6.0"),
  ], aptTarget, ["gdb"]);
  expect(selected?.path).toBe("/kernel-5-gdb-13.tar");
});

test("APT package epoch 优先于无 epoch 的较大首段数字", () => {
  const bundle = (path: string, version: string) => ({
    path,
    manifest: {
      schema: "doctor-packages/v1" as const,
      bundleVersion: "0.0.4",
      packageManager: "apt-get" as const,
      osId: "debian",
      osVersionId: "12",
      architecture: "amd64",
      packages: ["gdb"],
      packageVersions: { gdb: version },
    },
  });
  const selected = selectPackageBundle([
    bundle("/gdb-13.tar", "13.1-3"),
    bundle("/gdb-17.tar", "1:17.2-doctor1"),
  ], aptTarget, ["gdb"]);
  expect(selected?.path).toBe("/gdb-17.tar");
});

test("单个 package set 按 Target kernel 选择并临时提取 GDB variant", () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-package-set-"));
  const legacy = createFixtureBundle({
    root,
    name: "gdb-13",
    version: "13.1-3",
    maxExclusive: "6.0",
  });
  const modern = createFixtureBundle({
    root,
    name: "gdb-17",
    version: "1:17.2-doctor1",
    minInclusive: "6.0",
  });
  const setRoot = join(root, "set", "doctor-package-set");
  const variantsRoot = join(setRoot, "variants");
  mkdirSync(variantsRoot, { recursive: true });
  const variants = [legacy, modern].map((path) => {
    const name = path.endsWith("gdb-13.tar") ? "gdb-13" : "gdb-17";
    const target = join(variantsRoot, `${name}.tar`);
    copyFileSync(path, target);
    return {
      id: name,
      path: `doctor-package-set/variants/${name}.tar`,
      sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
      manifest: inspectPackageBundle(path).manifest,
    };
  });
  writeFileSync(join(setRoot, "manifest.json"), JSON.stringify({
    schema: "doctor-package-set/v1",
    bundleVersion: "0.0.3",
    variants,
  }));
  const setPath = join(root, "doctor-packages-0.0.3-gdb.tar");
  const archived = Bun.spawnSync({
    cmd: ["tar", "--format", "ustar", "-cf", setPath, "doctor-package-set"],
    cwd: join(root, "set"),
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(archived.exitCode).toBe(0);

  const bundles = inspectPackageBundles(setPath);
  expect(bundles).toHaveLength(2);
  const selectedLegacy = selectPackageBundle(bundles, aptTarget, ["gdb"]);
  expect(selectedLegacy?.variant?.id).toBe("gdb-13");
  const selectedModern = selectPackageBundle(
    bundles,
    { ...aptTarget, kernelVersion: "6.12.0" },
    ["gdb"],
  );
  expect(selectedModern?.variant?.id).toBe("gdb-17");

  const materialized = materializePackageBundle(selectedModern!);
  try {
    expect(materialized.path).not.toBe(setPath);
    expect(inspectPackageBundle(materialized.path).manifest.packageVersions?.gdb)
      .toBe("1:17.2-doctor1");
  } finally {
    materialized.cleanup();
  }
  expect(existsSync(materialized.path)).toBe(false);
});

test("apt 在线安装先更新索引，再安装 GDB", async () => {
  expect(onlineInstallCommands(aptTarget, ["gdb"])).toEqual([
    ["/usr/bin/apt-get", "update"],
    [
      "/usr/bin/env",
      "DEBIAN_FRONTEND=noninteractive",
      "/usr/bin/apt-get",
      "install",
      "-y",
      "--no-install-recommends",
      "gdb",
    ],
  ]);

  const calls: Array<{ target: ExecTarget; command: string[]; options?: RunOptions }> = [];
  const executor: Executor = {
    run: async () => result(),
    exec: async (target, command, options) => {
      calls.push({ target, command, options });
      return result();
    },
  };
  const installed = await kubernetesPackageInstaller.installOnline(
    executor,
    "app-0",
    "app",
    aptTarget,
    ["gdb"],
  );
  expect(installed.ok).toBe(true);
  expect(calls.map((call) => call.command)).toEqual([
    ["/usr/bin/apt-get", "update"],
    [
      "/usr/bin/env",
      "DEBIAN_FRONTEND=noninteractive",
      "/usr/bin/apt-get",
      "install",
      "-y",
      "--no-install-recommends",
      "gdb",
    ],
  ]);
});

test("安装前探测 Target kernel，而不是使用 Doctor Host kernel", async () => {
  const executor: Executor = {
    run: async () => result(),
    exec: async (_target, command) => {
      if (command[0] === "/usr/bin/apt-get") return result("apt 2.6");
      if (command.includes("/etc/os-release")) {
        return result("ID=debian\nVERSION_ID=\"12\"\n");
      }
      if (command.includes("--print-architecture")) return result("amd64\n");
      if (command.includes("-r")) return result("5.15.0-100-generic\n");
      return result();
    },
  };
  const target = await kubernetesPackageInstaller.inspect(executor, "app-0", "app");
  expect(target).toMatchObject({
    osId: "debian",
    osVersionId: "12",
    architecture: "amd64",
    kernelVersion: "5.15.0-100-generic",
  });
});

test("兼容性报告保留搜索其它 GDB 所需的 ABI、CPU 和 attach 错误", () => {
  const report: InstallCompatibilityReport = {
    schema: "doctor.install-compatibility/v1",
    generatedAt: "2026-07-28T08:00:00.000Z",
    target: {
      namespace: "default",
      pod: "executor-0",
      container: "doctor-debug",
      runtime: {
        ...aptTarget,
        osPrettyName: "Debian GNU/Linux 12 (bookworm)",
        kernelMachine: "x86_64",
        libc: { family: "glibc", version: "2.36", raw: "glibc 2.36" },
        python: {
          executable: "/usr/local/bin/python3",
          implementation: "CPython",
          version: "3.11.13",
        },
        cpu: { model: "Intel Xeon", flags: ["xsave", "xsaveopt", "avx2"] },
        security: { capEff: "0000000000080000", seccomp: "2", ptraceScope: "1" },
      },
    },
    gdb: {
      before: {
        available: true,
        pythonScripting: true,
        inferiorCall: false,
        version: "13.1",
        reason: "gdb 无法调用调试进程函数：Couldn't write extended state status: Bad address.",
      },
    },
    packageBundles: [],
    result: {
      status: "failed",
      stage: "gdb-capability",
      reason: "Couldn't write extended state status: Bad address.",
    },
  };
  const markdown = renderInstallCompatibilityMarkdown(report);
  expect(markdown).toContain("Debian GNU/Linux 12");
  expect(markdown).toContain("glibc 2.36");
  expect(markdown).toContain("xsave xsaveopt avx2");
  expect(markdown).toContain("Couldn't write extended state status: Bad address.");

  const root = mkdtempSync(join(tmpdir(), "doctor-install-report-"));
  const output = join(root, "compatibility.json");
  expect(writeInstallCompatibilityReport({ output }, report)).toBe(output);
  expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
    schema: "doctor.install-compatibility/v1",
    target: { runtime: { kernelVersion: "5.15.0-100-generic" } },
    result: { status: "failed" },
  });
});

test("apk 和 rpm 系包管理器走各自的非交互安装参数", async () => {
  const commands: string[][] = [];
  const executor: Executor = {
    run: async () => result(),
    exec: async (_target, command) => {
      commands.push(command);
      return result();
    },
  };
  await kubernetesPackageInstaller.installOnline(
    executor,
    "app-0",
    "app",
    { ...aptTarget, manager: { kind: "apk", path: "/sbin/apk" } },
    ["gdb"],
  );
  await kubernetesPackageInstaller.installOnline(
    executor,
    "app-0",
    "app",
    { ...aptTarget, manager: { kind: "dnf", path: "/usr/bin/dnf" } },
    ["gdb"],
  );
  expect(commands).toEqual([
    ["/sbin/apk", "add", "--no-cache", "gdb"],
    ["/usr/bin/dnf", "install", "-y", "gdb"],
  ]);
});

test("APT 离线安装把 GDB 作为 shell 位置参数传入", async () => {
  let command: string[] = [];
  const executor: Executor = {
    run: async () => result(),
    exec: async (_target, argv) => {
      command = argv;
      return result();
    },
  };
  await kubernetesPackageInstaller.installBundle(
    executor,
    "app-0",
    "app",
    aptTarget,
    ["gdb"],
    "/tmp/bundle.tar",
  );
  expect(command.slice(0, 3)).toEqual(["/bin/sh", "-c", expect.any(String)]);
  expect(command[4]).toBe("/tmp/bundle.tar");
  expect(command[6]).toBe("/usr/bin/apt-get");
  expect(command[2]).toContain("--allow-downgrades");
  expect(command.at(-1)).toBe("gdb");
});
