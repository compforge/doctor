import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectCpu, defaultCpuBundleName } from "../src/collect/cpu";
import { parsePtraceFacts, podDeclaresSysPtrace } from "../src/collect/fact/ptrace";
import type { ApprovalRequest } from "../src/command/approval";
import { CommandContext } from "../src/command";
import type {
  ExecResult,
  ExecTarget,
  Executor,
  RunOptions,
} from "../src/infra/k8s/executor";

const POD_JSON = JSON.stringify({
  metadata: {
    name: "app-0",
    namespace: "ns1",
    ownerReferences: [{ kind: "ReplicaSet", name: "app-rs", controller: true }],
  },
  spec: {
    nodeName: "node-a",
    containers: [{
      name: "app",
      image: "repo/app:1.2",
      resources: { limits: { cpu: "2", memory: "2Gi" } },
      securityContext: { capabilities: { add: ["SYS_PTRACE"] } },
    }],
  },
  status: {
    phase: "Running",
    containerStatuses: [{ name: "app", restartCount: 0, ready: true }],
  },
});

const DEBUG_POD_JSON = JSON.stringify({
  ...JSON.parse(POD_JSON),
  spec: {
    ...JSON.parse(POD_JSON).spec,
    ephemeralContainers: [{
      name: "doctor-debug-ready",
      image: "repo/doctor-debug:0.0.8-amd64",
      targetContainerName: "app",
      securityContext: { capabilities: { add: ["SYS_PTRACE"] } },
    }],
  },
  status: {
    ...JSON.parse(POD_JSON).status,
    ephemeralContainerStatuses: [{
      name: "doctor-debug-ready",
      state: { running: { startedAt: "2026-07-20T00:00:00Z" } },
    }],
  },
});

const PROCESS_SCAN = `   PID COMM              RSS_MB  THREADS    FDS
    11 python3              512       12    100

python workers (threads>4): 11
`;

const PY_SPY_DUMP = `Process 11: python3 -m app
Python v3.11.4 (/usr/local/bin/python3.11)

Thread 11 (active): "MainThread"
    work (app/worker.py:42)
`;

function result(command: string[], input: Partial<ExecResult> = {}): ExecResult {
  return {
    ok: true,
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 1,
    timedOut: false,
    command,
    ...input,
  };
}

class CpuExecutor implements Executor {
  readonly runCalls: string[][] = [];
  readonly execCalls: string[][] = [];
  readonly execTargets: ExecTarget[] = [];

  constructor(private readonly top = "app-0 app 200m 256Mi\n") {}

  async run(command: string[], _options?: RunOptions): Promise<ExecResult> {
    this.runCalls.push(command);
    const joined = command.join(" ");
    if (joined === "version --client") return result(command, { stdout: "Client Version: v1.31.0\n" });
    if (joined === "get pod app-0 -o json") return result(command, { stdout: POD_JSON });
    if (joined.startsWith("top pod app-0")) return result(command, { stdout: this.top });
    if (joined === "auth can-i create pods/exec") return result(command, { stdout: "yes\n" });
    if (joined === "auth can-i update pods/ephemeralcontainers") {
      return result(command, { stdout: "yes\n" });
    }
    return result(command);
  }

  async exec(target: ExecTarget, command: string[], _options?: RunOptions): Promise<ExecResult> {
    this.execTargets.push(target);
    this.execCalls.push(command);
    const joined = command.join(" ");
    if (joined.includes("command -v python3")) {
      return result(command, { stdout: "python3=yes\ngdb=yes\nproc=yes\n" });
    }
    if (joined.includes("CS_GNU_LIBC_VERSION")) {
      return result(command, { stdout: `${JSON.stringify({
        machine: "arm64",
        kernel_version: "6.1.0-test",
        glibc_version: "2.36",
        os_release: { id: "debian", version_id: "12", pretty_name: "Debian GNU/Linux 12" },
      })}\n` });
    }
    if (joined === "python3 - procscan --local") return result(command, { stdout: PROCESS_SCAN });
    if (joined.includes("shutil.which(\"py-spy\")")) {
      return result(command, {
        stdout: `${JSON.stringify({ py_spy_path: "/usr/bin/py-spy", pip_available: true })}\n`,
      });
    }
    if (joined.includes("sys_ptrace_effective")) {
      return result(command, {
        stdout: `${JSON.stringify({
          cap_eff_hex: "0000000000080000",
          sys_ptrace_effective: true,
          ptrace_scope: 1,
          caller_uid: 1000,
          target_uid: 1000,
          same_uid: true,
          seccomp_mode: 2,
          no_new_privs: false,
        })}\n`,
      });
    }
    if (command.includes("dump")) return result(command, { stdout: PY_SPY_DUMP });
    return result(command);
  }
}

class DebugExecutor extends CpuExecutor {
  override async run(command: string[], options?: RunOptions): Promise<ExecResult> {
    const joined = command.join(" ");
    if (joined === "get pod app-0 -o json") {
      this.runCalls.push(command);
      return result(command, { stdout: DEBUG_POD_JSON });
    }
    return super.run(command, options);
  }

  override async exec(target: ExecTarget, command: string[], options?: RunOptions): Promise<ExecResult> {
    this.execTargets.push(target);
    this.execCalls.push(command);
    const joined = command.join(" ");
    if (joined.includes("command -v python3")) {
      return result(command, { stdout: "python3=yes\ngdb=yes\nproc=yes\n" });
    }
    if (joined.includes("CS_GNU_LIBC_VERSION")) {
      return result(command, { stdout: `${JSON.stringify({
        machine: "arm64",
        kernel_version: "6.1.0-test",
        glibc_version: "2.36",
        os_release: { id: "debian", version_id: "12", pretty_name: "Debian GNU/Linux 12" },
      })}\n` });
    }
    if (joined === "python3 - procscan --local") return result(command, { stdout: PROCESS_SCAN });
    if (joined.includes("shutil.which(\"py-spy\")")) {
      return result(command, {
        stdout: `${JSON.stringify({ py_spy_path: null, pip_available: false })}\n`,
      });
    }
    if (joined.includes("sys_ptrace_effective")) {
      const effective = target.container === "doctor-debug-ready";
      return result(command, {
        stdout: `${JSON.stringify({
          cap_eff_hex: effective ? "0000000000080000" : "0",
          sys_ptrace_effective: effective,
          ptrace_scope: 1,
          caller_uid: 1000,
          target_uid: 1000,
          same_uid: true,
          seccomp_mode: 2,
          no_new_privs: false,
        })}\n`,
      });
    }
    if (command.includes("dump")) return result(command, { stdout: PY_SPY_DUMP });
    return result(command);
  }
}

function outputDir(): string {
  return join(mkdtempSync(join(tmpdir(), "doctor-cpu-test-")), "bundle");
}

describe("collectCpu", () => {
  test("overhead 复用公共 Facts，并把已有 py-spy 的线程栈写入 Evidence", async () => {
    const dir = outputDir();
    const exec = new CpuExecutor();
    const logs: string[] = [];
    const diagnosis = await collectCpu({
      config: {
        collect: { profileName: "test", kubernetes: { kubeconfigSource: "test", namespace: "ns1", namespaceSource: "flag" } },
        target: { pod: "app-0" },
        mode: "overhead",
      },
      outputDir: dir,
      approvalGate: async () => ({ approved: true, source: "prompt" }),
    }, new CommandContext({}), exec, (line) => logs.push(line));

    expect(diagnosis.code).toBe(0);
    expect(diagnosis.diagnosis!.evidence.observations[0]).toMatchObject({
      kind: "py-spy",
      pid: 11,
      threads: [{ tid: 11 }],
    });
    expect(logs.join("\n")).toContain("py-spy 执行前资源：CPU 10.0%");
    expect(exec.execCalls.flat().join(" ")).not.toContain("tracemalloc");

    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf-8"));
    expect(manifest.inspection_facts.resourceUsage.cpu.ratio).toBeCloseTo(0.1);
    expect(manifest.inspection_facts.resourceUsage.memory.ratio).toBeCloseTo(0.125);
    expect(manifest.inspection_facts.container).toMatchObject({
      kind: "target.container-capabilities",
      producer: { origin: "core", id: "container-capabilities" },
      python3: true,
      gdb: true,
      proc: true,
    });
    expect(manifest.inspection_facts.debug).toMatchObject({
      environments: [],
      reason: expect.stringContaining("doctor debug"),
    });
    expect(manifest.inspection_facts.platform).toMatchObject({
      kind: "target.platform",
      producer: { origin: "core", id: "platform" },
      machine: "arm64",
      kernelVersion: "6.1.0-test",
      glibcVersion: "2.36",
      osRelease: { id: "debian", versionId: "12", prettyName: "Debian GNU/Linux 12" },
    });
    expect(manifest.inspection_facts).not.toHaveProperty("pySpyRecovery");
  });

  test("高负载 Fact 在 py-spy probe 前触发确认，拒绝后不 attach", async () => {
    const dir = outputDir();
    const exec = new CpuExecutor("app-0 app 1800m 1536Mi\n");
    const approvals: ApprovalRequest[] = [];
    const logs: string[] = [];
    const diagnosis = await collectCpu({
      config: {
        collect: { profileName: "test", kubernetes: { kubeconfigSource: "test", namespace: "ns1", namespaceSource: "flag" } },
        target: { pod: "app-0" },
        mode: "overhead",
      },
      outputDir: dir,
      approvalGate: async (request) => {
        approvals.push(request);
        return { approved: false, source: "prompt" };
      },
    }, new CommandContext({}), exec, (line) => logs.push(line));

    expect(diagnosis.code).toBe(0);
    expect(approvals.map((approval) => approval.id)).toEqual(["py-spy-high-resource-usage"]);
    expect(logs.join("\n")).toContain("CPU 90.0%");
    expect(logs.join("\n")).toContain("内存 75.0%");
    expect(exec.execCalls.some((command) => command.includes("dump"))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf-8"));
    const pySpy = manifest.steps.find((step: any) => step.id === "py-spy-dump");
    expect(pySpy).toMatchObject({ status: "unavailable" });
  });

  test("observe 只收 Facts，不运行 py-spy", async () => {
    const exec = new CpuExecutor();
    const logs: string[] = [];
    const diagnosis = await collectCpu({
      config: {
        collect: { profileName: "test", kubernetes: { kubeconfigSource: "test", namespace: "ns1", namespaceSource: "flag" } },
        target: { pod: "app-0" },
        mode: "observe",
      },
      outputDir: outputDir(),
      approvalGate: async () => ({ approved: true, source: "prompt" }),
    }, new CommandContext({}), exec, (line) => logs.push(line));

    expect(diagnosis.code).toBe(0);
    expect(diagnosis.diagnosis!.evidence.observations).toEqual([]);
    expect(exec.execCalls.some((command) => command.includes("dump"))).toBe(false);
    expect(logs.join("\n")).toContain("Probe 不可用：py-spy（mode=observe 不 attach 目标进程）");
  });

  test("disrupt 未准备 doctor debug 时停止，不创建临时容器或 rollout", async () => {
    const exec = new CpuExecutor();
    const logs: string[] = [];
    const diagnosis = await collectCpu({
      config: {
        collect: { profileName: "test", kubernetes: { kubeconfigSource: "test", namespace: "ns1", namespaceSource: "flag" } },
        target: { pod: "app-0" },
        mode: "disrupt",
      },
      outputDir: outputDir(),
      approvalGate: async () => ({ approved: true, source: "prompt" }),
    }, new CommandContext({}), exec, (line) => logs.push(line));

    expect(diagnosis.code).toBe(0);
    expect(diagnosis.diagnosis!.evidence.observations).toEqual([]);
    expect(logs.join("\n")).toContain("doctor debug");
    expect(exec.runCalls.some((command) => ["debug", "patch", "apply"].includes(command[0]!))).toBe(false);
    expect(exec.execCalls.some((command) => command.includes("dump"))).toBe(false);
  });

  test("disrupt 只复用已就绪的 doctor debug 容器运行 py-spy", async () => {
    const dir = outputDir();
    const exec = new DebugExecutor();
    const diagnosis = await collectCpu({
      config: {
        collect: { profileName: "test", kubernetes: { kubeconfigSource: "test", namespace: "ns1", namespaceSource: "flag" } },
        target: { pod: "app-0" },
        mode: "disrupt",
      },
      outputDir: dir,
      approvalGate: async () => ({ approved: true, source: "prompt" }),
    }, new CommandContext({}), exec, () => {});

    expect(diagnosis.code).toBe(0);
    expect(diagnosis.diagnosis!.evidence.observations[0]).toMatchObject({ kind: "py-spy" });
    const patches = exec.runCalls.filter((command) => command[0] === "patch");
    expect(patches).toHaveLength(0);
    expect(exec.runCalls.some((command) => command[0] === "debug")).toBe(false);
    expect(exec.execTargets.some((target) => target.container === "doctor-debug-ready")).toBe(true);
    expect(exec.execCalls.flat().join(" ")).not.toContain("tracemalloc");
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf-8"));
    expect(manifest.steps.find((step: any) => step.id === "py-spy-debug-prereq"))
      .toMatchObject({ status: "ok" });
    expect(manifest.steps.find((step: any) => step.id === "py-spy-debug-dump"))
      .toMatchObject({ status: "ok" });
  });
});

test("CPU bundle 使用独立命名", () => {
  expect(defaultCpuBundleName("app-0", new Date(2026, 6, 16, 9, 5, 3)))
    .toBe("doctor-cpu-app-0-20260716-090503");
});

test("ptrace Facts 同时识别 Pod 声明与进程有效 SYS_PTRACE", () => {
  expect(podDeclaresSysPtrace(POD_JSON, "app")).toBe(true);
  expect(parsePtraceFacts(JSON.stringify({
    cap_eff_hex: "0000000000080000",
    sys_ptrace_effective: true,
    ptrace_scope: 1,
    caller_uid: 1000,
    target_uid: 1000,
    same_uid: true,
    seccomp_mode: 2,
    no_new_privs: true,
  }), true)).toMatchObject({
    sysPtraceDeclared: true,
    sysPtraceEffective: true,
    attachLikely: true,
    ptraceScope: 1,
  });
});
