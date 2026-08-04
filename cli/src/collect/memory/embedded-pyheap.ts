import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

declare global {
  var __DOCTOR_PYHEAP_DUMPER_ASSET__: string | undefined;
  var __DOCTOR_PYHEAP_ANALYZER_ASSET__: string | undefined;
}

export type EmbeddedPyHeapTool = "dumper" | "analyzer";

const extracted = new Map<EmbeddedPyHeapTool, string>();
let extractedDirectory: string | undefined;

function readSeaAsset(tool: EmbeddedPyHeapTool): Uint8Array | undefined {
  if (process.versions.bun || !process.getBuiltinModule) return undefined;
  const sea = process.getBuiltinModule("node:sea") as typeof import("node:sea");
  if (!sea.isSea()) return undefined;
  const key = tool === "dumper" ? "doctor-pyheap-dumper" : "doctor-pyheap-analyzer";
  return new Uint8Array(sea.getRawAsset(key));
}

function readBunAsset(tool: EmbeddedPyHeapTool): Uint8Array | undefined {
  const path = tool === "dumper"
    ? globalThis.__DOCTOR_PYHEAP_DUMPER_ASSET__
    : globalThis.__DOCTOR_PYHEAP_ANALYZER_ASSET__;
  return path ? readFileSync(path) : undefined;
}

function readDevelopmentAsset(tool: EmbeddedPyHeapTool): Uint8Array | undefined {
  const currentDirectory = dirname(fileURLToPath(import.meta.url));
  const filename = tool === "dumper"
    ? "pyheap_dump-0.7.0+doctor.2.gz"
    : "pyheap_analyzer-0.7.0+doctor.2.gz";
  const path = resolve(currentDirectory, "../../../assets/pyheap", filename);
  return existsSync(path) ? readFileSync(path) : undefined;
}

/** 将内嵌的 gzip PEX 解压到仅当前 Doctor 进程可访问的临时目录。 */
export function resolveEmbeddedPyHeapTool(tool: EmbeddedPyHeapTool): string {
  const previous = extracted.get(tool);
  if (previous) return previous;
  const compressed = readSeaAsset(tool) ?? readBunAsset(tool) ?? readDevelopmentAsset(tool);
  if (!compressed) throw new Error(`Doctor 未携带 PyHeap ${tool} 工具`);

  extractedDirectory ??= mkdtempSync(join(tmpdir(), "doctor-pyheap-tools-"));
  const path = join(extractedDirectory, tool === "dumper" ? "pyheap_dump" : "pyheap_analyzer");
  writeFileSync(path, gunzipSync(compressed), { mode: 0o700 });
  extracted.set(tool, path);
  return path;
}

process.once("exit", () => {
  if (extractedDirectory) rmSync(extractedDirectory, { recursive: true, force: true });
});
