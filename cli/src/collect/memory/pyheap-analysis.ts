import { readFileSync } from "node:fs";

export const PYHEAP_ANALYSIS_SCHEMA = "pyheap.analysis/v1";

export interface PyHeapTypeSummary {
  type_address: string;
  type_name: string;
  object_count: number;
  shallow_size_bytes: number;
}

export interface PyHeapFrameSummary {
  file_name: string;
  line_number: number;
  function_name: string;
  local_variables: Array<{
    name: string;
    object_address: string;
    type_name: string | null;
  }>;
}

export interface PyHeapThreadSummary {
  name: string;
  is_alive: boolean;
  is_daemon: boolean;
  retained_size_bytes: number | null;
  frames: PyHeapFrameSummary[];
}

export interface PyHeapRetainedObject {
  object_address: string;
  type_name: string;
  shallow_size_bytes: number;
  retained_size_bytes: number;
  string_representation: string | null;
  container_profile?: {
    item_count: number;
    key_types?: PyHeapTypeCount[];
    value_types?: PyHeapTypeCount[];
    element_types?: PyHeapTypeCount[];
  } | null;
  inbound_reference_paths?: PyHeapInboundReference[][];
}

export interface PyHeapTypeCount {
  type_name: string;
  object_count: number;
}

export interface PyHeapInboundReference {
  object_address: string;
  type_name: string;
}

export interface PyHeapAnalysis {
  schema: typeof PYHEAP_ANALYSIS_SCHEMA;
  source: {
    sha256: string;
    size_bytes: number;
    heap_format_version: number;
    created_at: string;
    with_string_representations: boolean;
  };
  heap: {
    object_count: number;
    type_count: number;
    thread_count: number;
    referent_count: number;
    shallow_size_bytes: number;
  };
  types: PyHeapTypeSummary[];
  threads: PyHeapThreadSummary[];
  retained_heap: {
    status: "not_computed" | "complete";
    top_n: number;
    top_objects: PyHeapRetainedObject[];
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** JSON reader 是外部协议适配边界；detector 只接收已经验证过的领域对象。 */
export function readPyHeapAnalysis(path: string): PyHeapAnalysis {
  const value = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  if (!isRecord(value) || value.schema !== PYHEAP_ANALYSIS_SCHEMA) {
    throw new Error(`不是受支持的 ${PYHEAP_ANALYSIS_SCHEMA} 文件: '${path}'`);
  }
  const source = value.source;
  const heap = value.heap;
  const retained = value.retained_heap;
  if (!isRecord(source)
    || typeof source.sha256 !== "string"
    || !isFiniteNonNegative(source.size_bytes)
    || typeof source.created_at !== "string") {
    throw new Error(`PyHeap analysis 缺少有效 source: '${path}'`);
  }
  if (!isRecord(heap)
    || !isFiniteNonNegative(heap.object_count)
    || !isFiniteNonNegative(heap.type_count)
    || !isFiniteNonNegative(heap.thread_count)
    || !isFiniteNonNegative(heap.referent_count)
    || !isFiniteNonNegative(heap.shallow_size_bytes)) {
    throw new Error(`PyHeap analysis 缺少有效 heap summary: '${path}'`);
  }
  if (!Array.isArray(value.types) || !Array.isArray(value.threads)) {
    throw new Error(`PyHeap analysis 缺少 types 或 threads: '${path}'`);
  }
  if (!isRecord(retained)
    || (retained.status !== "complete" && retained.status !== "not_computed")
    || !Array.isArray(retained.top_objects)) {
    throw new Error(`PyHeap analysis 缺少有效 retained_heap: '${path}'`);
  }
  return value as unknown as PyHeapAnalysis;
}
