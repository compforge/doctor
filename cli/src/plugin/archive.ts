import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

const BLOCK_SIZE = 512;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 20_000;

interface TarEntry {
  path: string;
  type: "file" | "directory";
  mode: number;
  data: Buffer;
}

function field(buffer: Buffer, start: number, length: number): string {
  const end = buffer.indexOf(0, start);
  return buffer.toString("utf8", start, end >= start && end < start + length ? end : start + length).trim();
}

function safePath(path: string): boolean {
  return Boolean(path)
    && !path.startsWith("/")
    && !path.includes("\\")
    && !path.split("/").some((part) => part === ".." || part === "");
}

function readEntries(path: string): TarEntry[] {
  if (statSync(path).size > MAX_ARCHIVE_BYTES) throw new Error("Plugin archive is too large");
  const compressed = readFileSync(path);
  const tar = compressed[0] === 0x1f && compressed[1] === 0x8b
    ? gunzipSync(compressed, { maxOutputLength: MAX_EXPANDED_BYTES })
    : compressed;
  const entries: TarEntry[] = [];
  const names = new Set<string>();
  let offset = 0;
  while (offset + BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) break;
    const name = field(header, 0, 100);
    const prefix = field(header, 345, 155);
    const rawPath = prefix ? `${prefix}/${name}` : name;
    const entryPath = rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
    if (!safePath(entryPath) || names.has(entryPath)) {
      throw new Error(`Plugin archive contains an unsafe or duplicate path: ${rawPath}`);
    }
    const typeFlag = header[156] === 0 ? "0" : String.fromCharCode(header[156]!);
    if (typeFlag !== "0" && typeFlag !== "5") {
      throw new Error(`Plugin archive only allows files and directories: ${rawPath}`);
    }
    const size = Number.parseInt(field(header, 124, 12).replace(/^0+/, "") || "0", 8);
    const mode = Number.parseInt(field(header, 100, 8).replace(/^0+/, "") || "644", 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + BLOCK_SIZE + size > tar.length) {
      throw new Error(`Plugin archive entry has an invalid size: ${rawPath}`);
    }
    names.add(entryPath);
    entries.push({
      path: entryPath,
      type: typeFlag === "5" ? "directory" : "file",
      mode,
      data: tar.subarray(offset + BLOCK_SIZE, offset + BLOCK_SIZE + size),
    });
    if (entries.length > MAX_ENTRIES) throw new Error("Plugin archive contains too many entries");
    offset += BLOCK_SIZE + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
  }
  return entries;
}

export function extractPluginArchive(archive: string, destination: string): void {
  for (const entry of readEntries(archive)) {
    const output = join(destination, entry.path);
    if (entry.type === "directory") {
      mkdirSync(output, { recursive: true, mode: 0o755 });
      continue;
    }
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, entry.data, { mode: (entry.mode & 0o111) === 0 ? 0o644 : 0o755 });
  }
}
