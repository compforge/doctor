import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { runArgv, type ExecResult } from "../../infra/k8s/executor";

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
  return runArgv(
    ["tar", "-czf", resolve(archivePath), "-C", dirname(resolve(bundleDir)), basename(bundleDir)],
    { timeoutMs: 60_000 },
  );
}

/**
 * @rule 成功的诊断 Bundle 必须在根目录包含 report.html；领域原始 Evidence 仍由调用方保留。
 */
export async function packReportBundle(bundleDir: string, archivePath: string): Promise<ExecResult> {
  if (!existsSync(join(bundleDir, "report.html"))) {
    return {
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr: "诊断 Bundle 缺少根目录 report.html",
      durationMs: 0,
      timedOut: false,
      command: ["tar"],
    };
  }
  return packBundle(bundleDir, archivePath);
}
