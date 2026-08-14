import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceBundle } from "../src/collect/evidence";
import {
  captureMemoryHeap,
  parseCapturePreference,
  parseHeapDumpDetail,
  parseStrReprLen,
} from "../src/collect/memory/capture";
import { cgroupMemoryHint } from "../src/collect/memory/capture-risk";
import type { ExecResult, Executor } from "../src/infra/k8s/executor";
import {
  parsePyheapPrereqs,
  resolveKubernetesPyHeapDumper,
  runPyheapDumpCmd,
} from "../src/infra/dump";

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

describe("fork-pyheap capture", () => {
  test("parses capture options", () => {
    expect(parseHeapDumpDetail(undefined)).toBe("lite");
    expect(parseHeapDumpDetail("full")).toBe("full");
    expect(parseCapturePreference(undefined)).toBe("auto");
    expect(parseCapturePreference("target-container")).toBe("target-container");
    expect(parseStrReprLen("-1")).toBe(-1);
  });

  test("formats cgroup headroom without selecting a backend", () => {
    expect(cgroupMemoryHint({
      version: 1,
      currentBytes: String(3 * 1024 ** 3),
      limitBytes: String(4 * 1024 ** 3),
      events: {},
    })).toContain("剩余 1.00 GiB");
  });

  test("parses GDB prerequisites and builds the fork-pyheap command", () => {
    expect(parsePyheapPrereqs([
      "python3=/usr/bin/python3",
      "gdb=/usr/bin/gdb",
      "gdb_python=yes",
      "writable=yes",
      "pyheap=/opt/doctor/bin/pyheap_dump",
    ].join("\n"))).toEqual({
      python3: true,
      gdb: true,
      gdbPython: true,
      writable: true,
      dumper: true,
    });
    expect(runPyheapDumpCmd(8, "/tmp/doctor-pyheap/heap.pyheap", -1, true).at(-1))
      .toContain("--no-attribute");
  });

  test("materializes fork-pyheap from the optional Toolkit", () => {
    expect(existsSync(resolveKubernetesPyHeapDumper({
      pod: "app-0",
      container: "app",
      architecture: "amd64",
    }))).toBe(true);
  });

  test("doctor mem always checks PyHeap GDB prerequisites", async () => {
    const executor: Executor = {
      run: async () => execResult(),
      exec: async (_target, command) => {
        if (command[0] === "python3" && command[1] === "-") {
          return execResult("    8 python              64        8     10\npython workers (threads>4): 8\n");
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
    const result = await captureMemoryHeap(executor, {
      namespace: "ns",
      pod: "app-0",
      podJson: JSON.stringify({
        metadata: { name: "app-0" },
        spec: { containers: [{ name: "app", image: "example/app:1" }] },
        status: { containerStatuses: [{ name: "app", ready: true, restartCount: 0 }] },
      }),
      container: { name: "app", image: "example/app:1", restartCount: 0 },
      detail: "lite",
      strReprLen: -1,
      preference: "target-container",
      transferChunkBytes: 2 * 1024 * 1024,
      invokedAt: new Date("2026-08-13T08:00:00Z"),
      confirmed: false,
    }, {
      bundle: new EvidenceBundle(mkdtempSync(join(tmpdir(), "doctor-fork-pyheap-prereq-"))),
      confirm: async () => true,
    }, () => {});
    expect(result.code).toBe(1);
    expect(result.reasons).toContain("目标容器 app 缺少：gdb");
  });
});
