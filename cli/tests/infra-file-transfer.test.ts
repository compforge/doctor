import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostTargetFileTransfer } from "../src/infra/file-transfer";
import type { ExecResult, ExecTarget, Executor, RunOptions } from "../src/infra/k8s/executor";

function result(): ExecResult {
  return {
    ok: true,
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 1,
    timedOut: false,
    command: ["kubectl", "exec"],
  };
}

describe("Doctor Host ↔ Target file transfer", () => {
  test("调用方无需感知分片，原始字节以 2 MiB 上限流式落盘", async () => {
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 123, 0x5a);
    const lengths: number[] = [];
    const executor: Executor = {
      run: async () => { throw new Error("unexpected run"); },
      exec: async (_target: ExecTarget, command: string[], options?: RunOptions) => {
        const offset = Number(command.at(-2));
        const length = Number(command.at(-1));
        lengths.push(length);
        const slice = bytes.subarray(offset, offset + length);
        for (let cursor = 0; cursor < slice.byteLength; cursor += 64 * 1024) {
          options?.onStdoutBytes?.(slice.subarray(cursor, cursor + 64 * 1024));
        }
        return result();
      },
    };
    const dir = mkdtempSync(join(tmpdir(), "doctor-file-transfer-test-"));
    const output = join(dir, "artifact.part");
    const progress: Array<{ slice: number; totalSlices: number }> = [];
    try {
      const fetched = await hostTargetFileTransfer.downloadFromTarget({
        executor,
        target: { pod: "app-0", container: "doctor-debug" },
        targetPath: "/tmp/artifact.gz",
        hostPath: output,
        expectedBytes: bytes.byteLength,
        onProgress: ({ slice, totalSlices }) => progress.push({ slice, totalSlices }),
      });
      expect(fetched).toMatchObject({ ok: true, bytesWritten: bytes.byteLength, slices: 2, retries: 0 });
      expect(lengths).toEqual([2 * 1024 * 1024, 123]);
      expect(progress).toEqual([{ slice: 1, totalSlices: 2 }, { slice: 2, totalSlices: 2 }]);
      expect(readFileSync(output)).toEqual(bytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("小型工具通过 stdin 原子上传，并受显式体积上限约束", async () => {
    const directory = mkdtempSync(join(tmpdir(), "doctor-file-upload-test-"));
    const source = join(directory, "tool");
    const bytes = Buffer.from("pyheap-tool");
    writeFileSync(source, bytes);
    let stdin: string | Uint8Array | undefined;
    let command: string[] = [];
    const executor: Executor = {
      run: async () => { throw new Error("unexpected run"); },
      exec: async (_target, argv, options) => {
        command = argv;
        stdin = options?.stdin;
        return result();
      },
    };
    try {
      expect(await hostTargetFileTransfer.uploadToTarget({
        executor,
        target: { pod: "app-0", container: "app" },
        hostPath: source,
        targetPath: "/tmp/doctor-pyheap/pyheap_dump",
      })).toMatchObject({ ok: true });
      expect(Buffer.from(stdin as Uint8Array)).toEqual(bytes);
      expect(command).toContain("/tmp/doctor-pyheap/pyheap_dump");
      expect(command.join(" ")).toContain("os.replace");

      expect(hostTargetFileTransfer.uploadToTarget({
        executor,
        target: { pod: "app-0", container: "app" },
        hostPath: source,
        targetPath: "/tmp/doctor-pyheap/pyheap_dump",
        maxBytes: 1,
      })).rejects.toThrow("超过上限");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
