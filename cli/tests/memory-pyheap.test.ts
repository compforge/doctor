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
  parsePyHeapDetail,
  parseStrReprLen,
  resolveMemoryCapturePaths,
  pyheapDumpFailureReason,
} from "../src/collect/memory/capture";
import { EvidenceBundle } from "../src/collect/evidence";
import type { ExecResult, Executor, RunOptions } from "../src/infra/k8s/executor";
import { resolveEmbeddedPyHeapTool } from "../src/collect/memory/embedded-pyheap";
import { parsePyheapPrereqs } from "../src/collect/memory/pyheap-tool";

function analysis(source: {
  sha256: string;
  size: number;
  createdAt: string;
  dictCount?: number;
  dictBytes?: number;
}) {
  return {
    schema: "pyheap.analysis/v1",
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
    detail: "lite" as const,
    strReprLen: -1,
    preference: "auto" as const,
    transferChunkBytes: 2 * 1024 * 1024,
    invokedAt: new Date("2026-07-27T08:00:00Z"),
    confirmed: false,
  };
}

describe("doctor mem PyHeap capture contract", () => {
  test("parses capture options without a side-effect mode", () => {
    expect(parsePyHeapDetail(undefined)).toBe("lite");
    expect(parsePyHeapDetail("full")).toBe("full");
    expect(parseCapturePreference(undefined)).toBe("auto");
    expect(parseCapturePreference("target-container")).toBe("target-container");
    expect(parseStrReprLen("-1")).toBe(-1);
    expect(() => parseCapturePreference("observe")).toThrow("--capture-via");
  });

  test("requires GDB Python scripting and a writable tool directory", () => {
    expect(parsePyheapPrereqs([
      "python3=/usr/bin/python3",
      "gdb=/usr/bin/gdb",
      "gdb_python=yes",
      "writable=yes",
      "pyheap=missing",
    ].join("\n"))).toEqual({
      python3: true,
      gdb: true,
      gdbPython: true,
      writable: true,
      pyheap: false,
    });
  });

  test("materializes bundled dumper and analyzer PEX files", () => {
    expect(readFileSync(resolveEmbeddedPyHeapTool("dumper"), "utf-8")).toStartWith("#!");
    expect(readFileSync(resolveEmbeddedPyHeapTool("analyzer"), "utf-8")).toStartWith("#!");
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

  test("heap dump 摘要跳过 auto-load warning 并报告真实 GDB 错误", () => {
    const failed = {
      ...execResult("", false),
      stderr: [
        "warning: File python-gdb.py auto-loading has been declined",
        "Traceback (most recent call last):",
        "gdb.error: Couldn't write extended state status: Bad address.",
      ].join("\n"),
    };
    expect(pyheapDumpFailureReason(failed)).toBe(
      "GDB 无法调用目标进程函数：Couldn't write extended state status: Bad address.",
    );
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
      pyheap_version: "0.7.0+doctor.2",
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

  test("stops with explicit deficiencies when debug is absent and target GDB is inadequate", async () => {
    const executor: Executor = {
      run: async () => execResult(),
      exec: async (_target, command) => {
        if (command[0] === "python3" && command[1] === "-") {
          return execResult("    12 python              64        8     10\npython workers (threads>4): 12\n");
        }
        return execResult([
          "python3=/usr/bin/python3",
          "gdb=missing",
          "gdb_python=no",
          "writable=yes",
          "pyheap=missing",
        ].join("\n"));
      },
    };
    const directory = mkdtempSync(join(tmpdir(), "doctor-memory-no-gdb-"));
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
      "目标容器 app 缺少：gdb",
      "未执行 attach，也未生成 heap 文件",
    ]);
    expect(confirmationAsked).toBe(false);
  });

  test("asks for confirmation before uploading a dumper into a capable target container", async () => {
    let uploadAttempted = false;
    const executor: Executor = {
      run: async () => execResult(),
      exec: async (_target, command, options?: RunOptions) => {
        if (options?.stdin instanceof Uint8Array) uploadAttempted = true;
        if (command[0] === "python3" && command[1] === "-") {
          return execResult("    12 python              64        8     10\npython workers (threads>4): 12\n");
        }
        if (command.includes("--version")) return execResult("GNU gdb 16.3\n");
        if (command.some((part) => part.includes("DOCTOR_GDB_PYTHON_OK"))) {
          return execResult("DOCTOR_GDB_PYTHON_OK\n");
        }
        if (command.some((part) => part.includes("DOCTOR_GDB_INFERIOR_CALL_OK"))) {
          return execResult("DOCTOR_GDB_INFERIOR_CALL_OK\n");
        }
        if (command.includes("/proc/sys/kernel/yama/ptrace_scope")) {
          return execResult();
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
        return execResult([
          "python3=/usr/bin/python3",
          "gdb=/usr/bin/gdb",
          "gdb_python=yes",
          "writable=yes",
          "pyheap=missing",
        ].join("\n"));
      },
    };
    const directory = mkdtempSync(join(tmpdir(), "doctor-memory-confirm-first-"));
    const result = await captureMemoryHeap(
      executor,
      captureParams(),
      {
        bundle: new EvidenceBundle(directory),
        confirm: async () => false,
      },
      () => {},
    );
    expect(result.code).toBe(130);
    expect(result.strategy).toBe("target-container");
    expect(uploadAttempted).toBe(false);
  });

  test("rejects an XSAVE-incompatible debug-container GDB before ptrace and confirmation", async () => {
    let ptraceAttempted = false;
    let confirmationAsked = false;
    const executor: Executor = {
      run: async () => execResult(),
      exec: async (_target, command) => {
        if (command[0] === "python3" && command[1] === "-") {
          return execResult("    12 python              64        8     10\npython workers (threads>4): 12\n");
        }
        if (command.includes("--version")) return execResult("GNU gdb 13.1\n");
        if (command.some((part) => part.includes("DOCTOR_GDB_PYTHON_OK"))) {
          return execResult("DOCTOR_GDB_PYTHON_OK\n");
        }
        if (command.some((part) => part.includes("DOCTOR_GDB_INFERIOR_CALL_OK"))) {
          return {
            ...execResult("", false),
            stderr: "Couldn't write extended state status: Bad address.\n",
          };
        }
        if (command.includes("/proc/sys/kernel/yama/ptrace_scope")) {
          ptraceAttempted = true;
        }
        return execResult([
          "python3=/usr/bin/python3",
          "gdb=/usr/bin/gdb",
          "gdb_python=yes",
          "writable=yes",
          "pyheap=missing",
        ].join("\n"));
      },
    };
    const directory = mkdtempSync(join(tmpdir(), "doctor-memory-incompatible-gdb-"));
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
          return true;
        },
      },
      () => {},
    );
    expect(result.code).toBe(1);
    expect(result.reasons).toEqual([
      "debug environment doctor-debug-broken（image=repo/doctor-debug:broken）的 "
        + "GDB 13.1 不满足 PyHeap attach 前置："
        + "gdb 无法调用调试进程函数：Couldn't write extended state status: Bad address.；"
        + "请更换包含兼容 GDB 的 doctor debug image，"
        + "或对该 debug container 执行 doctor install gdb",
      "未执行 attach，也未生成 heap 文件",
    ]);
    expect(ptraceAttempted).toBe(false);
    expect(confirmationAsked).toBe(false);
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
      pyheap_version: "0.7.0+doctor.2",
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
      join(directory, "capture.pyheap-analysis.json"),
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

  test("falls back to a locally loaded doctor-debug image when host Python is unavailable", async () => {
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
      expect(existsSync(join(directory, "capture.pyheap-analysis.json"))).toBe(true);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  test("compares multiple analysis JSON files by type deltas", async () => {
    const directory = mkdtempSync(join(tmpdir(), "doctor-mema-compare-"));
    const first = join(directory, "first.pyheap-analysis.json");
    const second = join(directory, "second.pyheap-analysis.json");
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
    writeFileSync(join(directory, "capture.pyheap-analysis.json"), "{}");
    const captureIndex = join(directory, "doctor-mem-app-0-pid12-20260727-080000.json");
    writeFileSync(captureIndex, JSON.stringify({
      schema: MEMORY_CAPTURE_SCHEMA,
      captured_at: "2026-07-27T08:00:00Z",
      pyheap_version: "0.7.0+doctor.2",
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
