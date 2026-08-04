import {
  closeSync,
  ftruncateSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import type { ExecResult } from "../k8s/executor";
import type {
  DownloadFromTargetOptions,
  DownloadFromTargetResult,
  HostTargetFileTransfer,
  UploadToTargetOptions,
} from "./model";

// 客户网络可能经过响应缓冲较小的代理；小片 + offset 重试比单次大 stdout 更稳。
const DEFAULT_FETCH_CHUNK_BYTES = 2 * 1024 * 1024;
const FETCH_SLICE_TIMEOUT_MS = 10 * 60_000;
const FETCH_SLICE_MAX_ATTEMPTS = 3;
const DEFAULT_UPLOAD_MAX_BYTES = 64 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 10 * 60_000;

const READ_FILE_SLICE_SCRIPT = String.raw`
import sys

path, offset, length = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
with open(path, "rb") as file:
    file.seek(offset)
    data = file.read(length)
sys.stdout.buffer.write(data)
`;

function readFileSliceCommand(path: string, offset: number, length: number): string[] {
  return ["python3", "-c", READ_FILE_SLICE_SCRIPT, path, String(offset), String(length)];
}

function writeAll(fd: number, chunk: Uint8Array, position: number): void {
  let written = 0;
  while (written < chunk.byteLength) {
    written += writeSync(fd, chunk, written, chunk.byteLength - written, position + written);
  }
}

/**
 * 通过多次 kubectl exec 将 Target 文件下载到 Doctor Host。
 *
 * 远端读取脚本依赖容器内已有 python3；调用方应在进入本能力前完成 readiness 检查。
 * 每片只有完整到达才推进 offset；短读、非零退出或链路异常都会截回片头重试，
 * 避免把失败尝试的部分字节混入最终 artifact。
 */
async function downloadFromTarget(
  options: DownloadFromTargetOptions,
): Promise<DownloadFromTargetResult> {
  const fd = openSync(options.hostPath, "w", 0o600);
  let fetchedBytes = 0;
  let slices = 0;
  let retries = 0;
  try {
    const chunkBytes = options.chunkBytes ?? DEFAULT_FETCH_CHUNK_BYTES;
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
      throw new Error(`文件传输 chunkBytes 必须是正整数: ${chunkBytes}`);
    }
    const totalSlices = Math.ceil(options.expectedBytes / chunkBytes);
    options.onStart?.(totalSlices);
    while (fetchedBytes < options.expectedBytes) {
      const length = Math.min(chunkBytes, options.expectedBytes - fetchedBytes);
      let failure: DownloadFromTargetResult["failure"];
      for (let attempt = 1; attempt <= FETCH_SLICE_MAX_ATTEMPTS; attempt += 1) {
        let receivedBytes = 0;
        const result = await options.executor.exec(
          options.target,
          readFileSliceCommand(options.targetPath, fetchedBytes, length),
          {
            timeoutMs: FETCH_SLICE_TIMEOUT_MS,
            collectStdout: false,
            onStdoutBytes: (chunk) => {
              writeAll(fd, chunk, fetchedBytes + receivedBytes);
              receivedBytes += chunk.byteLength;
            },
          },
        );
        if (result.ok && receivedBytes === length) {
          fetchedBytes += length;
          slices += 1;
          options.onProgress?.({
            slice: slices,
            totalSlices,
            fetchedBytes,
            totalBytes: options.expectedBytes,
          });
          failure = undefined;
          break;
        }

        ftruncateSync(fd, fetchedBytes);
        failure = {
          offset: fetchedBytes,
          expectedBytes: length,
          receivedBytes,
          result,
        };
        if (attempt < FETCH_SLICE_MAX_ATTEMPTS) {
          retries += 1;
          const reason = result.ok
            ? `期望 ${length} 字节，实得 ${receivedBytes}`
            : result.stderr.trim() || `exit=${result.exitCode}`;
          options.onRetry?.(fetchedBytes, attempt + 1, reason);
        }
      }
      if (failure) {
        return { ok: false, bytesWritten: fetchedBytes, slices, retries, failure };
      }
    }
    return { ok: true, bytesWritten: fetchedBytes, slices, retries };
  } finally {
    closeSync(fd);
    if (fetchedBytes !== options.expectedBytes) rmSync(options.hostPath, { force: true });
  }
}

const WRITE_REMOTE_FILE_SCRIPT = String.raw`
import os
import sys

path = sys.argv[1]
mode = int(sys.argv[2], 8)
directory = os.path.dirname(path)
os.makedirs(directory, mode=0o700, exist_ok=True)
temporary = path + ".part"
try:
    with open(temporary, "wb") as file:
        while chunk := sys.stdin.buffer.read(1 << 20):
            file.write(chunk)
    os.chmod(temporary, mode)
    os.replace(temporary, path)
finally:
    try:
        os.unlink(temporary)
    except FileNotFoundError:
        pass
`;

/**
 * 通过 kubectl exec stdin 将 Doctor Host 文件原子上传到 Target。
 *
 * 该路径只用于把 Doctor 自带的小型诊断工具送入已经通过 Python/磁盘前置检查的
 * 目标容器；显式体积上限避免误把大型现场文件读入 Doctor 内存。
 */
async function uploadToTarget(options: UploadToTargetOptions): Promise<ExecResult> {
  const bytes = statSync(options.hostPath).size;
  const maxBytes = options.maxBytes ?? DEFAULT_UPLOAD_MAX_BYTES;
  if (bytes > maxBytes) {
    throw new Error(`待上传文件 ${bytes} 字节，超过上限 ${maxBytes} 字节`);
  }
  return options.executor.exec(
    options.target,
    ["python3", "-c", WRITE_REMOTE_FILE_SCRIPT, options.targetPath, "0700"],
    {
      stdin: readFileSync(options.hostPath),
      timeoutMs: UPLOAD_TIMEOUT_MS,
    },
  );
}

export const kubernetesHostTargetFileTransfer: HostTargetFileTransfer = {
  downloadFromTarget,
  uploadToTarget,
};
