#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { checkPluginVersion } from "./version";
import {
  calculatePluginArtifactDigest,
  DOCTOR_PLUGIN_API_VERSION,
} from "../src/artifact";

const BLOCK_SIZE = 512;

interface PluginPackage {
  version: string;
  doctorPlugin?: { requiresDoctor?: string };
}

function octal(value: number, length: number): Buffer {
  return Buffer.from(`${value.toString(8).padStart(length - 1, "0")}\0`, "ascii");
}

function tarName(path: string): { name: string; prefix?: string } {
  if (Buffer.byteLength(path) <= 100) return { name: path };
  const split = path.lastIndexOf("/");
  if (split <= 0) throw new Error(`Plugin archive path is too long: ${path}`);
  const prefix = path.slice(0, split);
  const name = path.slice(split + 1);
  if (Buffer.byteLength(prefix) > 155 || Buffer.byteLength(name) > 100) {
    throw new Error(`Plugin archive path is too long: ${path}`);
  }
  return { name, prefix };
}

function tarHeader(path: string, mode: number, size: number, directory: boolean): Buffer {
  const header = Buffer.alloc(BLOCK_SIZE);
  const { name, prefix } = tarName(path);
  header.write(name, 0, 100, "utf8");
  octal(mode, 8).copy(header, 100);
  octal(0, 8).copy(header, 108);
  octal(0, 8).copy(header, 116);
  octal(size, 12).copy(header, 124);
  octal(0, 12).copy(header, 136);
  header.fill(0x20, 148, 156);
  header[156] = directory ? 0x35 : 0x30;
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  if (prefix) header.write(prefix, 345, 155, "utf8");
  octal(header.reduce((sum, byte) => sum + byte, 0), 8).copy(header, 148);
  return header;
}

function archiveEntries(root: string, current = root): string[] {
  return readdirSync(current, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Plugin archive cannot contain symlinks: ${path}`);
      if (entry.isDirectory()) return [path, ...archiveEntries(root, path)];
      if (entry.isFile()) return [path];
      throw new Error(`Plugin archive only supports regular files: ${path}`);
    });
}

function writeTarGz(root: string, output: string): void {
  const blocks: Buffer[] = [];
  for (const path of archiveEntries(root)) {
    const stats = statSync(path);
    const archivePath = relative(root, path).split(sep).join("/") + (stats.isDirectory() ? "/" : "");
    const data = stats.isDirectory() ? Buffer.alloc(0) : readFileSync(path);
    const mode = stats.isDirectory() || (stats.mode & 0o111) !== 0 ? 0o755 : 0o644;
    blocks.push(tarHeader(archivePath, mode, data.length, stats.isDirectory()));
    if (data.length) {
      blocks.push(data, Buffer.alloc((BLOCK_SIZE - data.length % BLOCK_SIZE) % BLOCK_SIZE));
    }
  }
  blocks.push(Buffer.alloc(BLOCK_SIZE * 2));
  writeFileSync(output, gzipSync(Buffer.concat(blocks), { level: 9 }));
}

function skillPaths(pluginRoot: string): string[] {
  const root = join(pluginRoot, "skills");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "SKILL.md")))
    .map((entry) => `./skills/${entry.name}`)
    .sort();
}

export async function buildPluginArchive(pluginRoot: string, outputDir?: string): Promise<string> {
  const root = resolve(pluginRoot);
  const lock = checkPluginVersion(root);
  const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as PluginPackage;
  const dist = resolve(outputDir ?? join(root, "dist"));
  const temporary = mkdtempSync(join(tmpdir(), "doctor-plugin-build-"));
  const stage = join(temporary, "package");
  try {
    mkdirSync(stage, { recursive: true });
    const result = await Bun.build({
      entrypoints: [join(root, "src", "index.ts")],
      outdir: stage,
      naming: "plugin.mjs",
      target: "bun",
      format: "esm",
      sourcemap: "none",
      minify: false,
    });
    if (!result.success) {
      throw new Error(result.logs.map((log) => log.message).join("\n") || "Plugin bundle failed");
    }
    if (existsSync(join(root, "skills"))) {
      cpSync(join(root, "skills"), join(stage, "skills"), { recursive: true, errorOnExist: true });
    }
    const contentDigest = calculatePluginArtifactDigest(stage);
    writeFileSync(join(stage, "plugin.json"), `${JSON.stringify({
      manifestVersion: 1,
      pluginApiVersion: DOCTOR_PLUGIN_API_VERSION,
      id: lock.pluginId,
      version: metadata.version,
      requiresDoctor: metadata.doctorPlugin?.requiresDoctor ?? ">=0.1.0",
      contentDigest,
      main: "./plugin.mjs",
      skills: skillPaths(root),
    }, null, 2)}\n`);

    rmSync(dist, { recursive: true, force: true });
    mkdirSync(dist, { recursive: true });
    const output = join(dist, `${lock.pluginId}-${lock.version}.doctor-plugin.tar.gz`);
    writeTarGz(stage, output);
    return output;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const root = Bun.argv[2];
  if (!root) throw new Error("usage: pack.ts <plugin-root> [output-dir]");
  const output = await buildPluginArchive(root, Bun.argv[3]);
  process.stdout.write(`built: ${output}\n`);
}
