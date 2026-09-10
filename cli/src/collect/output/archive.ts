import {
  copyFileSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { runArgv, type ExecResult } from "@compforge/harness-toolbox/kubernetes/executor";

/** -o 给了就用（无 .tar.gz/.tgz 后缀时补 .tar.gz）；缺省 ./<bundleName>.tar.gz */
export function resolveArchivePath(output: string | undefined, bundleName: string): string {
  if (!output) return join(".", `${bundleName}.tar.gz`);
  if (output.endsWith(".tar.gz") || output.endsWith(".tgz")) return output;
  return `${output}.tar.gz`;
}

export interface DefaultReportPaths {
  html: string;
  bundle: string;
}

/** 未指定 format 时，-o 表示同一份报告的 basename，而不是某一种交付格式。 */
export function resolveDefaultReportPaths(
  output: string | undefined,
  reportName: string,
): DefaultReportPaths {
  const candidate = output?.trim() || join(".", reportName);
  const base = candidate
    .replace(/\.tar\.gz$/i, "")
    .replace(/\.tgz$/i, "")
    .replace(/\.(?:html|json|md)$/i, "");
  return { html: `${base}.html`, bundle: `${base}.tar.gz` };
}

/**
 * 把证据目录打成 tar.gz（归档内保留 bundle 目录名作顶层，解开即还原目录形态）。
 * 用系统 tar：macOS / Linux 运维机都自带，免引第三方依赖进单二进制。
 */
export async function packBundle(bundleDir: string, archivePath: string): Promise<ExecResult> {
  const path = resolve(bundleDir);
  if (!existsSync(path)) return failedPack(`命令登记的产物不存在: ${path}`);
  if (!lstatSync(path).isDirectory()) return failedPack(`Bundle 必须是目录: ${path}`);
  return runArgv(
    ["tar", "-czf", resolve(archivePath), "-C", dirname(path), basename(path)],
    { timeoutMs: 60_000 },
  );
}

function failedPack(stderr: string): ExecResult {
  return {
    ok: false,
    exitCode: 1,
    stdout: "",
    stderr,
    durationMs: 0,
    timedOut: false,
    command: ["tar"],
  };
}

function archiveRootName(archivePath: string): string {
  return basename(archivePath)
    .replace(/\.tar\.gz$/i, "")
    .replace(/\.tgz$/i, "")
    || "doctor-evidence";
}

function stagePath(source: string, destination: string): void {
  const stats = lstatSync(source);
  if (stats.isDirectory()) {
    mkdirSync(destination);
    for (const entry of readdirSync(source)) {
      stagePath(join(source, entry), join(destination, entry));
    }
    return;
  }
  if (stats.isSymbolicLink()) {
    symlinkSync(readlinkSync(source), destination);
    return;
  }
  if (!stats.isFile()) throw new Error(`不支持归档特殊文件: ${source}`);
  try {
    linkSync(source, destination);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!code || !["EACCES", "EMLINK", "EPERM", "EXDEV"].includes(code)) throw error;
    copyFileSync(source, destination);
  }
}

export interface ArchiveEntry {
  readonly source: string;
  /** Explicit path relative to the archive's single root directory. */
  readonly path: string;
}

/** Delivery owns layout; the archiver only stages explicit destinations and preserves directory contents. */
export async function packArchiveEntries(entries: readonly ArchiveEntry[], archivePath: string): Promise<ExecResult> {
  if (!entries.length) return failedPack("命令没有登记可交付产物");
  const paths = entries.map(entry => normalize(entry.path));
  for (const [index, path] of paths.entries()) {
    if (isAbsolute(path) || path === "." || path === ".." || path.startsWith(`..${sep}`)) {
      return failedPack(`无效归档路径: ${entries[index]!.path}`);
    }
    if (paths.some((other, otherIndex) => otherIndex !== index && (other === path || other.startsWith(`${path}${sep}`)))) {
      return failedPack(`归档目标路径冲突: ${path}`);
    }
    if (!existsSync(entries[index]!.source)) return failedPack(`命令登记的产物不存在: ${entries[index]!.source}`);
  }
  const stagingRoot = mkdtempSync(join(tmpdir(), "doctor-archive-"));
  const rootName = archiveRootName(archivePath);
  const archiveRoot = join(stagingRoot, rootName);
  mkdirSync(archiveRoot);
  try {
    for (const [index, entry] of entries.entries()) {
      const destination = join(archiveRoot, paths[index]!);
      mkdirSync(dirname(destination), { recursive: true });
      stagePath(entry.source, destination);
    }
    return await runArgv(
      ["tar", "-czf", resolve(archivePath), "-C", stagingRoot, rootName],
      { timeoutMs: 60_000 },
    );
  } catch (error) {
    return failedPack(`Bundle 暂存失败: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

/**
 * @rule 成功的诊断 artifact 在打包前必须包含 report.html；领域原始 Evidence 仍由调用方保留。
 */
export async function packReportBundle(bundleDir: string, archivePath: string): Promise<ExecResult> {
  if (!existsSync(join(bundleDir, "report.html"))) {
    return failedPack("诊断 Bundle 缺少根目录 report.html");
  }
  return packBundle(bundleDir, archivePath);
}
