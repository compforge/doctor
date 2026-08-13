import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { CgroupMemoryFacts } from "../fact/cgroup-memory";

export const MEMORY_CAPTURE_SCHEMA = "doctor.memory-capture/v1";

export interface MemoryCaptureArtifact {
  schema: typeof MEMORY_CAPTURE_SCHEMA;
  captured_at: string;
  pydump_version: string;
  target: {
    namespace: string;
    pod: string;
    pod_uid?: string;
    container: string;
    image: string;
    image_id?: string;
    restart_count: number;
    pid: number;
    process_start_time?: string;
  };
  capture: {
    strategy: "debug-container" | "target-container";
    execution_container: string;
    detail: "lite" | "full";
    str_repr_len: number;
  };
  heap: {
    file: string;
    size_bytes: number;
    sha256: string;
  };
  facts: {
    process_scan?: unknown;
    cgroup_memory?: string | CgroupMemoryFacts;
    process_status?: string;
    target_libc?: {
      family: "glibc" | "musl" | "unknown";
      version?: string;
      raw?: string;
    };
    pydump_agent?: {
      python_minor: string;
      architecture: string;
      glibc_min: string;
    };
  };
}

export function readMemoryCaptureArtifact(path: string): MemoryCaptureArtifact {
  const value = JSON.parse(readFileSync(path, "utf-8")) as Partial<MemoryCaptureArtifact>;
  if (
    value.schema !== MEMORY_CAPTURE_SCHEMA
    || typeof value.captured_at !== "string"
    || typeof value.target?.namespace !== "string"
    || typeof value.target.pod !== "string"
    || typeof value.target.container !== "string"
    || !Number.isInteger(value.target.pid)
    || typeof value.heap?.file !== "string"
    || !Number.isSafeInteger(value.heap.size_bytes)
    || !/^[a-f0-9]{64}$/.test(value.heap.sha256 ?? "")
  ) {
    throw new Error(`不是受支持的 ${MEMORY_CAPTURE_SCHEMA} 文件: '${path}'`);
  }
  return value as MemoryCaptureArtifact;
}

export function resolveCaptureHeapPath(
  artifactPath: string,
  artifact: MemoryCaptureArtifact,
): string {
  return resolve(dirname(artifactPath), artifact.heap.file);
}
