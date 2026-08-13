import { readFileSync } from "node:fs";

export const PYDUMP_ANALYSIS_SCHEMA = "pydump.analysis/v1";

export interface PydumpTypeSummary {
  type_address: string;
  type_name: string;
  object_count: number;
  shallow_size_bytes: number;
}

export interface PydumpFrameSummary {
  file_name: string;
  line_number: number;
  function_name: string;
  local_variables: Array<{
    name: string;
    object_address: string;
    type_name: string | null;
  }>;
}

export interface PydumpThreadSummary {
  name: string;
  is_alive: boolean;
  is_daemon: boolean;
  retained_size_bytes: number | null;
  frames: PydumpFrameSummary[];
}

export interface PydumpRetainedObject {
  object_address: string;
  type_name: string;
  shallow_size_bytes: number;
  retained_size_bytes: number;
  string_representation: string | null;
  container_profile?: {
    item_count: number;
    key_types?: PydumpTypeCount[];
    value_types?: PydumpTypeCount[];
    element_types?: PydumpTypeCount[];
  } | null;
  inbound_reference_paths?: PydumpInboundReference[][];
}

export interface PydumpTypeCount {
  type_name: string;
  object_count: number;
}

export interface PydumpInboundReference {
  object_address: string;
  type_name: string;
}

export interface PydumpAnalysis {
  schema: typeof PYDUMP_ANALYSIS_SCHEMA;
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
  types: PydumpTypeSummary[];
  threads: PydumpThreadSummary[];
  retained_heap: {
    status: "not_computed" | "complete";
    top_n: number;
    top_objects: PydumpRetainedObject[];
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** JSON reader 是外部协议适配边界；detector 只接收已经验证过的领域对象。 */
export function readPydumpAnalysis(path: string): PydumpAnalysis {
  const value = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  if (!isRecord(value) || value.schema !== PYDUMP_ANALYSIS_SCHEMA) {
    throw new Error(`不是受支持的 ${PYDUMP_ANALYSIS_SCHEMA} 文件: '${path}'`);
  }
  const source = value.source;
  const heap = value.heap;
  const retained = value.retained_heap;
  if (!isRecord(source)
    || typeof source.sha256 !== "string"
    || !isFiniteNonNegative(source.size_bytes)
    || typeof source.created_at !== "string") {
    throw new Error(`Pydump analysis 缺少有效 source: '${path}'`);
  }
  if (!isRecord(heap)
    || !isFiniteNonNegative(heap.object_count)
    || !isFiniteNonNegative(heap.type_count)
    || !isFiniteNonNegative(heap.thread_count)
    || !isFiniteNonNegative(heap.referent_count)
    || !isFiniteNonNegative(heap.shallow_size_bytes)) {
    throw new Error(`Pydump analysis 缺少有效 heap summary: '${path}'`);
  }
  if (!Array.isArray(value.types) || !Array.isArray(value.threads)) {
    throw new Error(`Pydump analysis 缺少 types 或 threads: '${path}'`);
  }
  if (!isRecord(retained)
    || (retained.status !== "complete" && retained.status !== "not_computed")
    || !Array.isArray(retained.top_objects)) {
    throw new Error(`Pydump analysis 缺少有效 retained_heap: '${path}'`);
  }
  return value as unknown as PydumpAnalysis;
}
