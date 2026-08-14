import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findMemoryAnalysisInputs, runMemoryAnalysis } from "../src/collect/memory/analysis";
import {
  MEMORY_CAPTURE_SCHEMA,
  readMemoryCaptureArtifact,
  resolveCaptureHeapPath,
} from "../src/collect/memory/capture-artifact";
import {
  captureMemoryHeap,
  confirmedRemoteHeapPath,
  parseCapturePreference,
  parsePydumpDetail,
  parseStrReprLen,
  resolveMemoryCapturePaths,
  pydumpDumpFailureReason,
} from "../src/collect/memory/capture";
import { EvidenceBundle } from "../src/collect/evidence";
import type { ExecResult, Executor, RunOptions } from "../src/infra/k8s/executor";
import {
  resolveHostPydumpAnalyzer,
  resolveKubernetesPydumpCaptureTools,
} from "../src/collect/memory/toolkit-pydump";
import {
  parsePydumpPrereqs,
  parsePydumpTargetLibc,
  runPydumpDumpCmd,
  selectPydumpAgentMinGlibc,
} from "../src/collect/memory/pydump-tool";
import {
  cgroupOomKillCount,
  parseCgroupMemoryFacts,
} from "../src/collect/fact/cgroup-memory";
import { pydumpMemoryRiskLines } from "../src/collect/memory/capture-risk";

function analysis(source: {
  sha256: string;
  size: number;
  createdAt: string;
  dictCount?: number;
  dictBytes?: number;
}) {
  return {
    schema: "pydump.analysis/v1",
    source: {
      sha256: source.sha256,
      size_bytes: source.size,
      heap_format_version: 1,
      created_at: source.createdAt,
      with_string_representations: false,
    },
    heap: {
      object_count: source.dictCount ?? 10,
      type_count: 1,
      thread_count: 0,
      referent_count: 20,
      shallow_size_bytes: source.dictBytes ?? 1024,
    },
    types: [{
      type_address: "0x1",
      type_name: "dict",
      object_count: source.dictCount ?? 10,
      shallow_size_bytes: source.dictBytes ?? 1024,
    }],
    threads: [],
    retained_heap: { status: "complete", top_n: 0, top_objects: [] },
  };
}

function execResult(stdout = "", ok = true): ExecResult {
  return {
    ok,
    exitCode: ok ? 0 : 1,
    stdout,
    stderr: ok ? "" : "failed",
    durationMs: 1,
    timedOut: false,
    command: [],
  };
}

const podJson = JSON.stringify({
  metadata: { name: "app-0", namespace: "ns", uid: "pod-uid" },
  spec: {
    containers: [{
      name: "app",
      image: "example/app:1",
      securityContext: { capabilities: { add: ["SYS_PTRACE"] } },
    }],
  },
  status: {
    phase: "Running",
    containerStatuses: [{
      name: "app",
      imageID: "sha256:image",
      restartCount: 0,
      ready: true,
    }],
  },
});

const podJsonWithDebug = (() => {
  const pod = JSON.parse(podJson);
  pod.spec.ephemeralContainers = [{
    name: "doctor-debug-broken",
    image: "repo/doctor-debug:broken",
    targetContainerName: "app",
    securityContext: { capabilities: { add: ["SYS_PTRACE"] } },
  }];
  pod.status.ephemeralContainerStatuses = [{
    name: "doctor-debug-broken",
    state: { running: {} },
  }];
  return JSON.stringify(pod);
})();

function captureParams() {
  return {
    namespace: "ns",
    pod: "app-0",
    podJson,
    container: {
      name: "app",
      image: "example/app:1",
      imageId: "sha256:image",
      restartCount: 0,
    },
    backend: "pydump" as const,
    detail: "lite" as const,
    strReprLen: -1,
    preference: "auto" as const,
    transferChunkBytes: 2 * 1024 * 1024,
    invokedAt: new Date("2026-07-27T08:00:00Z"),
    confirmed: false,
  };
}

describe("doctor mem Pydump capture contract", () => {
  test("parses capture options without a side-effect mode", () => {
    expect(parsePydumpDetail(undefined)).toBe("lite");
    expect(parsePydumpDetail("full")).toBe("full");
    expect(parseCapturePreference(undefined)).toBe("auto");
    expect(parseCapturePreference("target-container")).toBe("target-container");
    expect(parseStrReprLen("-1")).toBe(-1);
    expect(() => parseCapturePreference("observe")).toThrow("--capture-via");
  });

  test("requires Python and a writable tool directory while discovering bundled tools", () => {
    expect(parsePydumpPrereqs([
      "python3=/usr/bin/python3",
      "writable=yes",
      "collector=missing",
      "injector=/opt/doctor/bin/pydump-injector",
    ].join("\n"))).toEqual({
      python3: true,
      writable: true,
      collector: false,
      injector: true,
    });
  });

  test("selects an Agent only when the target satisfies its minimum glibc", () => {
    expect(parsePydumpTargetLibc('{"family":"glibc","version":"2.31","raw":"glibc 2.31"}\n'))
      .toEqual({ family: "glibc", version: "2.31", raw: "glibc 2.31" });
    expect(selectPydumpAgentMinGlibc("2.31-13+deb11u14")).toBe("2.17");
    expect(selectPydumpAgentMinGlibc("2.17")).toBe("2.17");
    expect(selectPydumpAgentMinGlibc("2.16")).toBeUndefined();
  });

  test("passes the prepared Injector explicitly to Pydump", () => {
    expect(runPydumpDumpCmd(
      12,
      "/tmp/doctor-pydump/heap.pyheap",
      -1,
      "/tmp/doctor-pydump/agent.so",
      "/tmp/doctor-pydump/pydump-injector",
    ).at(-1)).toContain("--injector /tmp/doctor-pydump/pydump-injector");
  });

  test("materializes the standalone Toolkit analyzer", () => {
    expect(existsSync(resolveHostPydumpAnalyzer())).toBe(true);
  });

  test("materializes the optional Pydump capture components", () => {
    const tools = resolveKubernetesPydumpCaptureTools({
      pod: "app-0",
      container: "app",
      architecture: "amd64",
      pythonMinor: "3.11",
      minGlibcVersion: "2.17",
    });
    expect(existsSync(tools.collector)).toBe(true);
    expect(existsSync(tools.injector)).toBe(true);
    expect(existsSync(tools.agent)).toBe(true);
  });

  test("writes a stable heap and capture sidecar basename", () => {
    const paths = resolveMemoryCapturePaths(
      "capture",
      "app-0",
      12,
      new Date("2026-07-27T08:00:00Z"),
    );
    expect(paths.heapPath).toEndWith("/capture.pyheap");
    expect(paths.capturePath).toEndWith("/capture.json");
  });

  test("heap dump 摘要报告 ptrace Injector 错误", () => {
    const failed = {
      ...execResult("", false),
      stderr: "pydump failed: ptrace injector failed for PID 12: attach PID 12: operation not permitted",
    };
    expect(pydumpDumpFailureReason(failed)).toBe(
      "pydump failed: ptrace injector failed for PID 12: attach PID 12: operation not permitted",
    );
  });

  test("heap dump 摘要优先报告目标进程被 SIGKILL", () => {
    const failed = {
      ...execResult("", false),
      stderr: [
        "Program terminated with signal SIGKILL, Killed.",
        "pydump failed: target disconnected",
      ].join("\n"),
    };
    expect(pydumpDumpFailureReason(failed)).toBe(
      "目标进程在 dump 期间被 SIGKILL",
    );
  });

  test("reads cgroup v1 and v2 oom_kill counters used for dump-time deltas", () => {
    const v2 = [
      "version=2",
      "event_oom=7",
      "event_oom_kill=3",
    ].join("\n");
    const v1 = [
      "version=1",
      "event_fail_count=3",
      "event_oom_kill_disable=0",
      "event_under_oom=0",
      "event_oom_kill=4",
    ].join("\n");

    const v2Facts = parseCgroupMemoryFacts(v2);
    const v1Facts = parseCgroupMemoryFacts(v1);
    expect(v2Facts?.version).toBe(2);
    expect(cgroupOomKillCount(v2Facts)).toBe(3);
    expect(v1Facts?.version).toBe(1);
    expect(cgroupOomKillCount(v1Facts)).toBe(4);
    expect(parseCgroupMemoryFacts("memory cgroup files unavailable")).toBeUndefined();
  });

  test("reports cgroup memory facts without a headroom warning", () => {
    const lines = pydumpMemoryRiskLines({
      cgroupMemory: {
        version: 1,
        currentBytes: String(7 * 1024 ** 3),
        limitBytes: String(8 * 1024 ** 3),
        events: {},
      },
      strategy: "debug-container",
    });

    expect(lines.some((line) => line.includes("Collector 的图遍历状态") && line.includes("debug container"))).toBe(true);
    expect(lines.some((line) => line.includes("7.00 GiB / 8.00 GiB"))).toBe(true);
    expect(lines.some((line) => line.includes("高风险"))).toBe(false);
  });

  test("只有远端 metadata 验证通过才报告 heap 文件保留", () => {
    expect(confirmedRemoteHeapPath("/tmp/heap.pyheap", execResult("", false))).toBeUndefined();
    expect(confirmedRemoteHeapPath(
      "/tmp/heap.pyheap",
      execResult(`42 ${"a".repeat(64)}\n`),
    )).toBe("/tmp/heap.pyheap");
  });

  test("reads capture sidecar and resolves its relative heap path", () => {
    const directory = mkdtempSync(join(tmpdir(), "doctor-memory-capture-artifact-"));
    const artifactPath = join(directory, "capture.json");
    writeFileSync(artifactPath, JSON.stringify({
      schema: MEMORY_CAPTURE_SCHEMA,
      captured_at: "2026-07-27T08:00:00Z",
      pydump_version: "0.1.0",
      target: {
        namespace: "ns",
        pod: "app-0",
        container: "app",
        image: "example/app:1",
        restart_count: 0,
        pid: 12,
      },
      capture: {
        strategy: "target-container",
        execution_container: "app",
        detail: "lite",
        str_repr_len: -1,
      },
      heap: { file: "capture.pyheap", size_bytes: 4, sha256: "a".repeat(64) },
      facts: {},
    }));
    const artifact = readMemoryCaptureArtifact(artifactPath);
    expect(resolveCaptureHeapPath(artifactPath, artifact)).toBe(join(directory, "capture.pyheap"));
  });

  test("stops with explicit deficiencies when the target cannot run the Collector", async () => {
    const executor: Executor = {
      run: async () => execResult(),
      exec: async (_target, command) => {
        if (command[0] === "python3" && command[1] === "-") {
          return execResult("    12 python              64        8     10\npython workers (threads>4): 12\n");
        }
        return execResult([
          "python3=missing",
          "writable=yes",
          "collector=missing",
          "injector=missing",
        ].join("\n"));
      },
    };
    const directory = mkdtempSync(join(tmpdir(), "doctor-memory-no-python-"));
    let confirmationAsked = false;
    const result = await captureMemoryHeap(
      executor,
      captureParams(),
      {
        bundle: new EvidenceBundle(directory),
        confirm: async () => {
          confirmationAsked = true;
          return true;
        },
      },
      () => {},
    );
    expect(result.code).toBe(1);
    expect(result.reasons).toEqual([
      "debug container 不可用：目标 Pod 中没有已就绪且具备 SYS_PTRACE 的 doctor debug 临时容器；请先执行 doctor debug",
      "目标容器 app 缺少：python3",
      "未执行 attach，也未生成 heap 文件",
    ]);
    expect(confirmationAsked).toBe(false);
  });

  test("asks for confirmation before uploading Pydump tools into a capable target container", async () => {
    let uploadAttempted = false;
    let libcProbeContainer: string | undefined;
    const logs: string[] = [];
    const executor: Executor = {
      run: async () => execResult(),
      exec: async (target, command, options?: RunOptions) => {
        if (options?.stdin instanceof Uint8Array) uploadAttempted = true;
        if (command[0] === "python3" && command[1] === "-") {
          return execResult([
            "    12 uvicorn             64        8     10",
            "python processes: 12",
            "python workers (threads>4): 12",
            "uvicorn topology: mode=standalone workers=12",
          ].join("\n"));
        }
        if (command.includes("/proc/sys/kernel/yama/ptrace_scope")) {
          return execResult();
        }
        if (
          command[0] === "python3"
          && command[1] === "-c"
          && command[2]?.includes("cannot uniquely detect target CPython minor")
        ) {
          return execResult("3.12\n");
        }
        if (command[0] === "python3" && command[1] === "-c" && command.at(-1) === "12") {
          return execResult(JSON.stringify({
            cap_eff_hex: "80000",
            sys_ptrace_effective: true,
            ptrace_scope: 1,
            caller_uid: 0,
            target_uid: 1000,
            same_uid: false,
            seccomp_mode: 0,
            no_new_privs: false,
          }));
        }
        if (command[0] === "/proc/12/exe") {
          libcProbeContainer = target.container;
          return execResult('{"family":"glibc","version":"2.31","raw":"glibc 2.31"}\n');
        }
        if (command[0] === "uname") return execResult("x86_64\n");
        return execResult([
          "python3=/usr/bin/python3",
          "writable=yes",
          "collector=missing",
          "injector=missing",
        ].join("\n"));
      },
    };
    const directory = mkdtempSync(join(tmpdir(), "doctor-memory-confirm-first-"));
    const result = await captureMemoryHeap(
      executor,
      {
        ...captureParams(),
        container: {
          ...captureParams().container,
          livenessProbe: { httpGet: { path: "/health", port: 8080 } },
        },
      },
      {
        bundle: new EvidenceBundle(directory),
        confirm: async () => false,
      },
      (line) => logs.push(line),
    );
    expect(result.code).toBe(130);
    expect(result.strategy).toBe("target-container");
    expect(uploadAttempted).toBe(false);
    expect(libcProbeContainer).toBe("app");
    expect(logs.some((line) => line.includes("目标 glibc 2.31") && line.includes("最低 glibc 2.17")))
      .toBe(true);
    expect(logs.some((line) => line.includes("内存风险：") && line.includes("Collector"))).toBe(true);
    expect(logs.some((line) => line.includes("单进程 Uvicorn") && line.includes("liveness"))).toBe(true);
  });

  test("uses a ptrace-capable debug container without inspecting GDB", async () => {
    let ptraceAttempted = false;
    let gdbAttempted = false;
    let confirmationAsked = false;
    const executor: Executor = {
      run: async () => execResult(),
      exec: async (_target, command) => {
        if (command.some((part) => /gdb|DOCTOR_GDB/i.test(part))) gdbAttempted = true;
        if (command[0] === "python3" && command[1] === "-") {
          return execResult("    12 python              64        8     10\npython workers (threads>4): 12\n");
        }
        if (command[0] === "python3" && command[1] === "-c" && command[2]?.includes("cap_eff")) {
          ptraceAttempted = true;
          return execResult(JSON.stringify({
            cap_eff_hex: "80000",
            sys_ptrace_effective: true,
            ptrace_scope: 1,
            caller_uid: 0,
            target_uid: 1000,
            same_uid: false,
            seccomp_mode: 0,
            no_new_privs: false,
          }));
        }
        if (command[0] === "/proc/12/exe") {
          return execResult('{"family":"glibc","version":"2.31","raw":"glibc 2.31"}\n');
        }
        if (command[0] === "python3" && command[1] === "-c"
          && command[2]?.includes("cannot uniquely detect target CPython minor")) {
          return execResult("3.12\n");
        }
        if (command[0] === "uname") return execResult("x86_64\n");
        return execResult([
          "python3=/usr/bin/python3",
          "writable=yes",
          "collector=/opt/doctor/bin/pydump",
          "injector=/opt/doctor/bin/pydump-injector",
        ].join("\n"));
      },
    };
    const directory = mkdtempSync(join(tmpdir(), "doctor-memory-ptrace-debug-"));
    const result = await captureMemoryHeap(
      executor,
      {
        ...captureParams(),
        podJson: podJsonWithDebug,
        preference: "debug-container",
      },
      {
        bundle: new EvidenceBundle(directory),
        confirm: async () => {
          confirmationAsked = true;
          return false;
        },
      },
      () => {},
    );
    expect(result.code).toBe(130);
    expect(ptraceAttempted).toBe(true);
    expect(gdbAttempted).toBe(false);
    expect(confirmationAsked).toBe(true);
  });
});

describe("doctor mema local analysis", () => {
  test("reuses matching analysis JSON next to an existing heap", async () => {
    const directory = mkdtempSync(join(tmpdir(), "doctor-mema-cache-"));
    const heapPath = join(directory, "capture.pyheap");
    const capturePath = join(directory, "capture.json");
    const body = "heap";
    const sha256 = createHash("sha256").update(body).digest("hex");
    writeFileSync(heapPath, body);
    writeFileSync(capturePath, JSON.stringify({
      schema: MEMORY_CAPTURE_SCHEMA,
      captured_at: "2026-07-27T08:00:00Z",
      pydump_version: "0.1.0",
      target: {
        namespace: "ns",
        pod: "app-0",
        container: "app",
        image: "example/app:1",
        restart_count: 0,
        pid: 12,
      },
      capture: {
        strategy: "target-container",
        execution_container: "app",
        detail: "lite",
        str_repr_len: -1,
      },
      heap: { file: "capture.pyheap", size_bytes: Buffer.byteLength(body), sha256 },
      facts: {},
    }));
    writeFileSync(
      join(directory, "capture.pydump-analysis.json"),
      JSON.stringify(analysis({
        sha256,
        size: Buffer.byteLength(body),
        createdAt: "2026-07-27T08:00:00Z",
      })),
    );
    const output = join(directory, "report.html");

    expect(await runMemoryAnalysis({ inputs: [capturePath], output })).toBe(0);
    expect(existsSync(output)).toBe(true);
  });

  test("prefers a locally loaded doctor-debug image for Host analysis", async () => {
    const directory = mkdtempSync(join(tmpdir(), "doctor-mema-container-fallback-"));
    const binDirectory = join(directory, "bin");
    const heapPath = join(directory, "capture.pyheap");
    const output = join(directory, "report.html");
    const body = "heap";
    const sha256 = createHash("sha256").update(body).digest("hex");
    writeFileSync(heapPath, body);
    mkdirSync(binDirectory);
    const analyzerOutput = JSON.stringify(analysis({
      sha256,
      size: Buffer.byteLength(body),
      createdAt: "2026-07-27T08:00:00Z",
    }));
    const docker = join(binDirectory, "docker");
    writeFileSync(docker, `#!/bin/sh
if [ "$1" = "info" ]; then exit 0; fi
if [ "$1" = "image" ] && [ "$2" = "ls" ]; then
  printf '%s\\n' 'doctor-debug:0.0.12-linux-amd64'
  exit 0
fi
case "$*" in
  *--help*) exit 0 ;;
esac
printf '%s\\n' '${analyzerOutput}'
`);
    chmodSync(docker, 0o755);

    const previousPath = process.env.PATH;
    process.env.PATH = binDirectory;
    try {
      expect(await runMemoryAnalysis({ inputs: [heapPath], output })).toBe(0);
      expect(existsSync(output)).toBe(true);
      expect(existsSync(join(directory, "capture.pydump-analysis.json"))).toBe(true);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  test("compares multiple analysis JSON files by type deltas", async () => {
    const directory = mkdtempSync(join(tmpdir(), "doctor-mema-compare-"));
    const first = join(directory, "first.pydump-analysis.json");
    const second = join(directory, "second.pydump-analysis.json");
    writeFileSync(first, JSON.stringify(analysis({
      sha256: "a".repeat(64),
      size: 100,
      createdAt: "2026-07-27T08:00:00Z",
      dictCount: 10,
      dictBytes: 1024,
    })));
    writeFileSync(second, JSON.stringify(analysis({
      sha256: "b".repeat(64),
      size: 200,
      createdAt: "2026-07-27T09:00:00Z",
      dictCount: 25,
      dictBytes: 4096,
    })));
    const output = join(directory, "comparison.html");

    expect(await runMemoryAnalysis({ inputs: [second, first], output })).toBe(0);
    const html = readFileSync(output, "utf-8");
    expect(html).toContain("多次对象堆对比");
    expect(html).toContain("对象数变化");
    expect(html).toContain("+15");
  });

  test("discovers capture indexes before derived analysis and raw heap files", () => {
    const directory = mkdtempSync(join(tmpdir(), "doctor-mema-discovery-"));
    writeFileSync(join(directory, "capture.pyheap"), "heap");
    writeFileSync(join(directory, "capture.pydump-analysis.json"), "{}");
    const captureIndex = join(directory, "doctor-mem-app-0-pid12-20260727-080000.json");
    writeFileSync(captureIndex, JSON.stringify({
      schema: MEMORY_CAPTURE_SCHEMA,
      captured_at: "2026-07-27T08:00:00Z",
      pydump_version: "0.1.0",
      target: {
        namespace: "ns",
        pod: "app-0",
        container: "app",
        image: "example/app:1",
        restart_count: 0,
        pid: 12,
      },
      capture: {
        strategy: "target-container",
        execution_container: "app",
        detail: "lite",
        str_repr_len: -1,
      },
      heap: { file: "capture.pyheap", size_bytes: 4, sha256: "a".repeat(64) },
      facts: {},
    }));
    expect(findMemoryAnalysisInputs(directory)).toEqual([captureIndex]);
  });
});
